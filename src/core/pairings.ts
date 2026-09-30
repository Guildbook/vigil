import { LOG_GAME_VERSIONS, LOG_VERSION_LABELS, type LogGameVersion } from "@/lib/vigil/game-version";

/**
 * The guilds this computer is paired with: at most one per game version, since a player can be in a WoW: Forever
 * guild and a TBC Anniversary guild at once. Pure functions, so the store and the upload routing can be tested
 * without Electron.
 */

export interface Pairing {
  /** The device ID the site issued; stable for the life of the pairing, and names the token file. */
  id: string;
  guild: { slug: string; name: string; gameVersion: LogGameVersion | null };
  /** The guild's own site as the home server named it, for links. API calls always go to the home server. */
  siteUrl: string | null;
  device: { id: string; name: string };
  pairedAt: string;
  /** Last successful upload, for picking a guild when the log's game is unknown. */
  lastUsedAt: string | null;
  /** The encrypted token's file in userData. Pairings migrated from 0.4.0 keep `device-token.bin`. */
  tokenFile: string;
}

export interface PairingsFile {
  version: 2;
  pairings: Pairing[];
}

/** The single pairing 0.4.0 wrote to `pairing.json`, with its token in `device-token.bin`. */
export interface LegacyPairing {
  siteUrl?: string | null;
  guild?: { slug?: string; name?: string; gameVersion?: string | null };
  device?: { id?: string; name?: string };
}

export const LEGACY_TOKEN_FILE = "device-token.bin";
const TOKEN_FILE = /^device-token(-[A-Za-z0-9_-]{1,80})?\.bin$/;

export function tokenFileFor(deviceId: string): string {
  const safe = deviceId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return safe ? `device-token-${safe}.bin` : LEGACY_TOKEN_FILE;
}

export function asGameVersion(v: unknown): LogGameVersion | null {
  return typeof v === "string" && (LOG_GAME_VERSIONS as readonly string[]).includes(v) ? (v as LogGameVersion) : null;
}

/** One pairing per game version; a guild whose version is not known yet is kept by its slug. */
export function pairingKey(p: Pick<Pairing, "guild">): string {
  return p.guild.gameVersion ?? `guild:${p.guild.slug}`;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function parsePairing(raw: unknown): Pairing | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const guild = r.guild as Record<string, unknown> | undefined;
  const device = r.device as Record<string, unknown> | undefined;
  const slug = str(guild?.slug);
  const deviceId = str(device?.id);
  if (!slug || !deviceId) return null;
  const tokenFile = str(r.tokenFile) ?? tokenFileFor(deviceId);
  if (!TOKEN_FILE.test(tokenFile)) return null;
  return {
    id: str(r.id) ?? deviceId,
    guild: { slug, name: str(guild?.name) ?? slug, gameVersion: asGameVersion(guild?.gameVersion) },
    siteUrl: str(r.siteUrl),
    device: { id: deviceId, name: str(device?.name) ?? "" },
    pairedAt: str(r.pairedAt) ?? new Date(0).toISOString(),
    lastUsedAt: str(r.lastUsedAt),
    tokenFile,
  };
}

/**
 * The saved pairings: `pairings.json` when it exists, else the 0.4.0 `pairing.json` as one entry (keeping its
 * token file; its game version is learned from the site's profile later). `migrated` means the caller should
 * write the new file. Duplicates for one game version keep the most recent pairing.
 */
export function loadPairingsFrom(saved: unknown, legacy: unknown, now: Date): { pairings: Pairing[]; migrated: boolean } {
  if (saved && typeof saved === "object" && Array.isArray((saved as PairingsFile).pairings)) {
    const list = (saved as PairingsFile).pairings.map(parsePairing).filter((p): p is Pairing => p !== null);
    return { pairings: dedupe(list), migrated: false };
  }
  const old = legacy as LegacyPairing | null;
  const one = old?.guild && old.device ? parsePairing({ ...old, pairedAt: now.toISOString(), tokenFile: LEGACY_TOKEN_FILE }) : null;
  return { pairings: one ? [one] : [], migrated: one !== null };
}

function dedupe(list: Pairing[]): Pairing[] {
  const byKey = new Map<string, Pairing>();
  for (const p of [...list].sort((a, b) => a.pairedAt.localeCompare(b.pairedAt))) {
    for (const [k, q] of byKey) if (q.guild.slug === p.guild.slug) byKey.delete(k);
    byKey.set(pairingKey(p), p);
  }
  return [...byKey.values()];
}

/**
 * Adds a pairing. It replaces the pairing for the same game version, and any earlier pairing with the same guild
 * (pairing a guild again). The replaced pairings come back so their tokens can be removed.
 */
export function addPairing(list: readonly Pairing[], next: Pairing): { pairings: Pairing[]; replaced: Pairing[] } {
  const key = pairingKey(next);
  const replaced = list.filter((p) => p.id === next.id || p.guild.slug === next.guild.slug || pairingKey(p) === key);
  return { pairings: [...list.filter((p) => !replaced.includes(p)), next], replaced };
}

/**
 * Records a game version the site reported for a pairing. An older pairing for that version is replaced (the
 * newer pairing wins) and comes back in `replaced`.
 */
export function setGameVersion(list: readonly Pairing[], id: string, gameVersion: LogGameVersion | null): { pairings: Pairing[]; replaced: Pairing[] } {
  const target = list.find((p) => p.id === id);
  if (!target || !gameVersion || target.guild.gameVersion === gameVersion) return { pairings: [...list], replaced: [] };
  const updated: Pairing = { ...target, guild: { ...target.guild, gameVersion } };
  const rest = list.filter((p) => p.id !== id);
  const rival = rest.find((p) => p.guild.gameVersion === gameVersion);
  if (!rival) return { pairings: list.map((p) => (p.id === id ? updated : p)), replaced: [] };
  if (rival.pairedAt > target.pairedAt) return { pairings: rest, replaced: [target] };
  return { pairings: [...rest.filter((p) => p !== rival), updated], replaced: [rival] };
}

/** Most recently used first, then most recently paired: the guild to use when nothing else decides. */
export function defaultPairing<T extends Pick<Pairing, "lastUsedAt" | "pairedAt">>(list: readonly T[]): T | null {
  const time = (p: T) => p.lastUsedAt ?? p.pairedAt;
  return [...list].sort((a, b) => time(b).localeCompare(time(a)) || b.pairedAt.localeCompare(a.pairedAt))[0] ?? null;
}

export type RouteReason = "match" | "only" | "unknown-guild" | "fallback" | "unknown-log" | "none";

export interface Route<T> {
  pairing: T | null;
  reason: RouteReason;
  /** For the player: the log's game and the guild's differ, or the guild was a guess. Null when all is well. */
  warning: string | null;
  /** The guild is known to be another game than the log. */
  mismatch: boolean;
}

type Routable = Pick<Pairing, "guild" | "lastUsedAt" | "pairedAt">;

const label = (v: LogGameVersion) => LOG_VERSION_LABELS[v];
const guildWithVersion = (p: Routable) => `${p.guild.name}${p.guild.gameVersion ? ` (${label(p.guild.gameVersion)})` : ""}`;

/**
 * The pairing a report uploads to, given the game its log is from.
 *
 * - The pairing for that game version when there is one.
 * - Otherwise a single pairing takes it: silently when the guild's version is not known yet, with a warning when
 *   the guild is known to be another game (the site keeps it with a warning before the WoW: Forever launch and
 *   refuses it after).
 * - With several pairings and none for that game: the only one whose version is unknown, else the default one
 *   (most recently used), with a warning.
 * - A log whose game is unknown goes to the only pairing, or the default one with a warning.
 */
export function pickPairing<T extends Routable>(pairings: readonly T[], detected: LogGameVersion | null | undefined): Route<T> {
  if (pairings.length === 0) return { pairing: null, reason: "none", warning: null, mismatch: false };
  if (!detected) {
    if (pairings.length === 1) return { pairing: pairings[0]!, reason: "only", warning: null, mismatch: false };
    const pick = defaultPairing(pairings)!;
    return {
      pairing: pick,
      reason: "unknown-log",
      warning: `Vigil could not tell which game this log is from, so it goes to ${guildWithVersion(pick)}.`,
      mismatch: false,
    };
  }
  const match = pairings.find((p) => p.guild.gameVersion === detected);
  if (match) return { pairing: match, reason: "match", warning: null, mismatch: false };
  const unknown = pairings.filter((p) => !p.guild.gameVersion);
  if (pairings.length === 1) {
    const only = pairings[0]!;
    if (!only.guild.gameVersion) return { pairing: only, reason: "unknown-guild", warning: null, mismatch: false };
    return {
      pairing: only,
      reason: "only",
      warning: `This log is from ${label(detected)} but Vigil is only paired with ${guildWithVersion(only)}. Pair Vigil with your ${label(detected)} guild.`,
      mismatch: true,
    };
  }
  if (unknown.length === 1) return { pairing: unknown[0]!, reason: "unknown-guild", warning: null, mismatch: false };
  if (unknown.length > 1) {
    const pick = defaultPairing(unknown)!;
    return {
      pairing: pick,
      reason: "fallback",
      warning: `This log is from ${label(detected)}. Vigil does not know yet which of your guilds plays it, so it goes to ${pick.guild.name}.`,
      mismatch: false,
    };
  }
  const pick = defaultPairing(pairings)!;
  return {
    pairing: pick,
    reason: "fallback",
    warning: `This log is from ${label(detected)} but none of your paired guilds is, so it goes to ${guildWithVersion(pick)}. Pair Vigil with your ${label(detected)} guild.`,
    mismatch: true,
  };
}

/** Game versions in the order the settings list them; guilds whose version is not known yet come last. */
export function groupByVersion<T extends Pick<Pairing, "guild">>(list: readonly T[]): { version: LogGameVersion | null; label: string; pairings: T[] }[] {
  const order: (LogGameVersion | null)[] = [...LOG_GAME_VERSIONS, null];
  return order
    .map((version) => ({
      version,
      label: version ? label(version) : "Game not known yet",
      pairings: list.filter((p) => (p.guild.gameVersion ?? null) === version),
    }))
    .filter((g) => g.pairings.length > 0);
}
