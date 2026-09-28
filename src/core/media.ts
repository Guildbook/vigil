import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WowClass } from "@/lib/game";
import iconData from "../data/spell-icons.json";

/**
 * Blizzard artwork for the window: spell icons and boss portraits from Blizzard's render CDN, cached on disk.
 *
 * The window asks for `vigil-media://` URLs (its CSP allows no network), and the main process answers from the
 * cache or fetches the image from render.worldofwarcraft.com, the only host it will contact for media. Cached
 * files expire after 30 days, the longest Blizzard's API terms allow for data from its services, and anything
 * unknown or unreachable comes back as the bundled fallback icon.
 */

export const MEDIA_SCHEME = "vigil-media";
export const RENDER_ORIGIN = "https://render.worldofwarcraft.com";
export const ICON_SIZES = [18, 36, 56] as const;
export type IconSize = (typeof ICON_SIZES)[number];
export const MEDIA_TTL_MS = 30 * 24 * 3600_000;

export interface IconIndex {
  icons: string[];
  spells: Record<string, number>;
  names: Record<string, number>;
  classes: Record<string, number[]>;
  missing: string[];
}

/** Spell ID (or class spell name) to icon name, from the generated Classic Era client data. */
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
  | { kind: "icon"; size: IconSize; icon: string | null }
  | { kind: "npc"; view: "zoom" | "portrait"; displayId: number };

/**
 * `vigil-media://spell/36/7386`, `vigil-media://spell-name/36/Sunder%20Armor`, `vigil-media://icon/36/<icon>`,
 * `vigil-media://npc/portrait/11121` or `vigil-media://npc/zoom/11121`. Null for anything else.
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
  if (kind === "spell") return /^\d{1,8}$/.test(b) ? { kind: "icon", size, icon: icons.byId(Number(b)) } : null;
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
