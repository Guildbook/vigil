import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WowClass } from "@/lib/game";
import iconData from "../data/spell-icons.json";

/**
 * Blizzard artwork for the window: spell icons and boss portraits from Blizzard's render CDN, cached on disk.
 *
 * The window asks for `vigil-media://` URLs (its CSP allows no network), and the main process answers from the
 * cache or fetches the image from render.worldofwarcraft.com, the only host it will contact for images. Cached
 * files expire after 30 days, the longest Blizzard's API terms allow for data from its services, and anything
 * unknown or unreachable comes back as the bundled fallback icon.
 *
 * Spells missing from the bundled map are looked up by numeric ID in Wowhead's tooltip data (SpellIconLookup),
 * which only yields an icon name; the image itself still comes from the render CDN.
 */

export const MEDIA_SCHEME = "vigil-media";
export const RENDER_ORIGIN = "https://render.worldofwarcraft.com";
export const ICON_SIZES = [18, 36, 56] as const;
export type IconSize = (typeof ICON_SIZES)[number];
export const MEDIA_TTL_MS = 30 * 24 * 3600_000;
export const WOWHEAD_TOOLTIP = "https://nether.wowhead.com/tooltip/spell";
/** Wowhead data environments, tried in order: TBC Classic, then Classic Era (which includes Season of Discovery). */
export const WOWHEAD_ENVS = [5, 4] as const;
export const LOOKUP_MISS_TTL_MS = 7 * 24 * 3600_000;

export interface IconIndex {
  icons: string[];
  spells: Record<string, number>;
  names: Record<string, number>;
  classes: Record<string, number[]>;
  missing: string[];
}

/** Spell ID (or class spell name) to icon name, from the generated Classic Era and TBC Anniversary client data. */
export class SpellIcons {
  private readonly missing: Set<string>;
  private classBySpell: Map<number, WowClass> | null = null;

  constructor(private readonly data: IconIndex = iconData as IconIndex) {
    this.missing = new Set(data.missing);
  }

  private icon(index: number | undefined): string | null {
    const name = index === undefined ? undefined : this.data.icons[index];
    return name && !this.missing.has(name) ? name : null;
  }

  byId(spellId: number): string | null {
    return this.icon(this.data.spells[String(spellId)]);
  }

  byName(name: string): string | null {
    return this.icon(this.data.names[name.trim().toLowerCase()]);
  }

  /** The class whose spell this is, or null for spells every class (or no class) has. */
  classOf(spellId: number): WowClass | null {
    if (!this.classBySpell) {
      this.classBySpell = new Map();
      for (const [cls, ids] of Object.entries(this.data.classes)) for (const id of ids) this.classBySpell.set(id, cls as WowClass);
    }
    return this.classBySpell.get(spellId) ?? null;
  }
}

export const isIconName = (name: string) => /^[a-z0-9_-]{1,80}$/.test(name);

export type MediaRequest =
  /** `spellId` is set for spell requests the bundled map could not answer, for SpellIconLookup. */
  | { kind: "icon"; size: IconSize; icon: string | null; spellId?: number }
  | { kind: "npc"; view: "zoom" | "portrait"; displayId: number };

/**
 * `vigil-media://spell/36/7386`, `vigil-media://spell-name/36/Sunder%20Armor`, `vigil-media://icon/36/<icon>`,
 * `vigil-media://npc/portrait/11121` or `vigil-media://npc/zoom/11121`. Null for anything else. A spell URL may
 * carry `?name=` for spells the map doesn't know by ID (other ranks, newer clients) but does know by name.
 */
export function parseMediaUrl(raw: string, icons: SpellIcons): MediaRequest | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${MEDIA_SCHEME}:`) return null;
  const parts = [url.hostname, ...url.pathname.split("/").filter(Boolean)].map((p) => decodeURIComponent(p));
  const [kind, a, b] = parts;
  if (parts.length !== 3 || !kind || !a || !b) return null;
  if (kind === "npc") {
    const displayId = Number(b);
    if ((a !== "zoom" && a !== "portrait") || !Number.isInteger(displayId) || displayId <= 0) return null;
    return { kind: "npc", view: a, displayId };
  }
  const size = Number(a) as IconSize;
  if (!ICON_SIZES.includes(size)) return null;
  if (kind === "spell") {
    if (!/^\d{1,8}$/.test(b)) return null;
    const spellId = Number(b);
    const name = url.searchParams.get("name");
    const icon = icons.byId(spellId) ?? (name && name.length <= 80 ? icons.byName(name) : null);
    return icon ? { kind: "icon", size, icon } : { kind: "icon", size, icon: null, spellId };
  }
  if (kind === "spell-name") return b.length <= 80 ? { kind: "icon", size, icon: icons.byName(b) } : null;
  if (kind === "icon") return isIconName(b) ? { kind: "icon", size, icon: b } : null;
  return null;
}

/** The render CDN address for a request, or null when there is nothing to fetch. */
export function upstreamUrl(req: MediaRequest): string | null {
  if (req.kind === "npc") return `${RENDER_ORIGIN}/us/npcs/${req.view}/creature-display-${req.displayId}.jpg`;
  return req.icon ? `${RENDER_ORIGIN}/us/icons/${req.size}/${req.icon}.jpg` : null;
}

/** Addresses to try in order. The CDN lacks small portraits for some models that do have the large render. */
export function upstreamUrls(req: MediaRequest): string[] {
  const first = upstreamUrl(req);
  if (!first) return [];
  if (req.kind === "npc" && req.view === "portrait") return [first, upstreamUrl({ ...req, view: "zoom" })!];
  return [first];
}

export interface MediaCacheOptions {
  dir: string;
  fetch: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

/** Images from the render CDN, kept on disk until they expire. Failed lookups are remembered for the session. */
export class MediaCache {
  private readonly inflight = new Map<string, Promise<Buffer | null>>();
  private readonly failed = new Set<string>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly opts: MediaCacheOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = Math.min(opts.ttlMs ?? MEDIA_TTL_MS, MEDIA_TTL_MS);
  }

  private file(url: string) {
    const rel = url.slice(RENDER_ORIGIN.length + 1).replace(/[^a-z0-9_.-]+/gi, "_");
    return path.join(this.opts.dir, rel);
  }

  /** Deletes expired files. Run at startup. */
  prune() {
    if (!existsSync(this.opts.dir)) return;
    for (const name of readdirSync(this.opts.dir)) {
      const p = path.join(this.opts.dir, name);
      if (this.now() - statSync(p).mtimeMs > this.ttlMs) rmSync(p, { force: true });
    }
  }

  async get(url: string): Promise<Buffer | null> {
    if (!url.startsWith(`${RENDER_ORIGIN}/`)) return null;
    const file = this.file(url);
    if (existsSync(file) && this.now() - statSync(file).mtimeMs <= this.ttlMs) return readFileSync(file);
    if (this.failed.has(url)) return null;
    let pending = this.inflight.get(url);
    if (!pending) {
      pending = this.download(url, file).finally(() => this.inflight.delete(url));
      this.inflight.set(url, pending);
    }
    return pending;
  }

  private async download(url: string, file: string): Promise<Buffer | null> {
    try {
      const res = await this.opts.fetch(url, { redirect: "error" });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) {
        this.failed.add(url);
        return null;
      }
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0 || body.length > 2_000_000) {
        this.failed.add(url);
        return null;
      }
      mkdirSync(this.opts.dir, { recursive: true });
      writeFileSync(file, body);
      return body;
    } catch {
      // Offline: try again later in the session rather than remembering the failure.
      return null;
    }
  }
}

export interface SpellIconLookupOptions {
  /** The media cache directory; answers are kept there as `spell-<id>.json` and pruned with the images. */
  dir: string;
  fetch: typeof fetch;
  now?: () => number;
  /** Least time between two requests to Wowhead. */
  minIntervalMs?: number;
  /** Pause after a network error or an overloaded answer before asking again. */
  backoffMs?: number;
  /** Lookups allowed to wait for a request slot; later ones get no answer this time. */
  maxQueue?: number;
  timeoutMs?: number;
}

type Lookup = { icon: string | null } | "retry";

/**
 * Spell ID to icon name for spells the bundled map lacks, from Wowhead's tooltip JSON (`{"icon": ...}`), TBC
 * data first, then Classic Era. Answers, including "no such spell", are cached on disk; requests go out one at a
 * time, spaced out, and stop for a while after errors, so being offline just leaves the fallback icon.
 */
export class SpellIconLookup {
  private readonly session = new Map<number, string | null>();
  private readonly inflight = new Map<number, Promise<string | null>>();
  private readonly now: () => number;
  private nextAt = 0;
  private pausedUntil = 0;
  private queued = 0;

  constructor(private readonly opts: SpellIconLookupOptions) {
    this.now = opts.now ?? Date.now;
  }

  private file(spellId: number) {
    return path.join(this.opts.dir, `spell-${spellId}.json`);
  }

  private fromDisk(spellId: number): string | null | undefined {
    const file = this.file(spellId);
    try {
      if (!existsSync(file)) return undefined;
      const { icon } = JSON.parse(readFileSync(file, "utf8")) as { icon?: unknown };
      const age = this.now() - statSync(file).mtimeMs;
      if (typeof icon === "string" && isIconName(icon)) return age <= MEDIA_TTL_MS ? icon : undefined;
      return icon === null && age <= LOOKUP_MISS_TTL_MS ? null : undefined;
    } catch {
      return undefined;
    }
  }

  /** The icon for a spell, or null if unknown or not reachable right now. */
  async resolve(spellId: number): Promise<string | null> {
    if (!Number.isSafeInteger(spellId) || spellId <= 0 || spellId > 99_999_999) return null;
    if (this.session.has(spellId)) return this.session.get(spellId)!;
    const cached = this.fromDisk(spellId);
    if (cached !== undefined) {
      this.session.set(spellId, cached);
      return cached;
    }
    let pending = this.inflight.get(spellId);
    if (!pending) {
      pending = this.lookup(spellId).finally(() => this.inflight.delete(spellId));
      this.inflight.set(spellId, pending);
    }
    return pending;
  }

  private async lookup(spellId: number): Promise<string | null> {
    if (this.now() < this.pausedUntil || this.queued >= (this.opts.maxQueue ?? 50)) return null;
    this.queued++;
    try {
      for (const env of WOWHEAD_ENVS) {
        await this.slot();
        if (this.now() < this.pausedUntil) return null;
        const found = await this.request(spellId, env);
        if (found === "retry") {
          this.pausedUntil = this.now() + (this.opts.backoffMs ?? 60_000);
          return null;
        }
        if (found.icon) return this.remember(spellId, found.icon);
      }
      return this.remember(spellId, null);
    } finally {
      this.queued--;
    }
  }

  private async slot() {
    const now = this.now();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(this.nextAt, now) + (this.opts.minIntervalMs ?? 250);
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private async request(spellId: number, env: number): Promise<Lookup> {
    try {
      const res = await this.opts.fetch(`${WOWHEAD_TOOLTIP}/${spellId}?dataEnv=${env}`, {
        redirect: "error",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
      });
      if (res.status === 404) return { icon: null };
      if (!res.ok) return "retry";
      const text = await res.text();
      if (text.length > 500_000) return { icon: null };
      const icon = (JSON.parse(text) as { icon?: unknown }).icon;
      const name = typeof icon === "string" ? icon.trim().toLowerCase() : "";
      return { icon: isIconName(name) ? name : null };
    } catch {
      return "retry";
    }
  }

  private remember(spellId: number, icon: string | null): string | null {
    this.session.set(spellId, icon);
    try {
      mkdirSync(this.opts.dir, { recursive: true });
      writeFileSync(this.file(spellId), JSON.stringify({ icon }));
    } catch {
      // A read-only disk only costs a lookup next session.
    }
    return icon;
  }
}
