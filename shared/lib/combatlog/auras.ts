import type { CombatEvent } from "./types";

export type Interval = [start: number, end: number];

export interface AuraTrack {
  key: string;
  dstGuid: string;
  intervals: Interval[];
  /** Stack count changes as [time, stacks]; 0 when the aura drops. */
  stacks: [number, number][];
}

/**
 * Builds aura intervals from SPELL_AURA_* events. `keyOf` maps an event to the aura it belongs to (or null
 * to ignore it). Auras first seen being refreshed or removed are treated as active since `windowStart`.
 */
export function trackAuras(
  events: CombatEvent[],
  keyOf: (ev: CombatEvent) => string | null,
  window: (dstGuid: string) => Interval,
  initiallyActive: (key: string, dstGuid: string) => boolean = () => false,
  seed: [key: string, dstGuid: string][] = [],
): Map<string, AuraTrack> {
  const tracks = new Map<string, AuraTrack & { since: number | null; seen: boolean }>();
  const get = (key: string, dst: string) => {
    const id = `${key}|${dst}`;
    let tr = tracks.get(id);
    if (!tr) {
      const [start] = window(dst);
      const active = initiallyActive(key, dst);
      tr = { key, dstGuid: dst, intervals: [], stacks: active ? [[start, 1]] : [], since: active ? start : null, seen: active };
      tracks.set(id, tr);
    }
    return tr;
  };

  for (const [key, dst] of seed) get(key, dst);

  for (const ev of events) {
    if (!ev.type.startsWith("SPELL_AURA_") || !ev.dst) continue;
    const key = keyOf(ev);
    if (!key) continue;
    const tr = get(key, ev.dst.guid);
    const [start] = window(ev.dst.guid);
    switch (ev.type) {
      case "SPELL_AURA_APPLIED":
        if (tr.since === null) tr.since = ev.t;
        tr.stacks.push([ev.t, 1]);
        break;
      case "SPELL_AURA_APPLIED_DOSE":
      case "SPELL_AURA_REMOVED_DOSE":
      case "SPELL_AURA_REFRESH":
        if (tr.since === null) tr.since = tr.seen ? ev.t : start;
        if (ev.stacks !== undefined) tr.stacks.push([ev.t, ev.stacks]);
        break;
      case "SPELL_AURA_REMOVED":
        tr.intervals.push([tr.since ?? (tr.seen ? ev.t : start), ev.t]);
        tr.since = null;
        tr.stacks.push([ev.t, 0]);
        break;
    }
    tr.seen = true;
  }

  const out = new Map<string, AuraTrack>();
  for (const [id, tr] of tracks) {
    const [, end] = window(tr.dstGuid);
    if (tr.since !== null) tr.intervals.push([tr.since, Math.max(tr.since, end)]);
    out.set(id, { key: tr.key, dstGuid: tr.dstGuid, intervals: mergeIntervals(tr.intervals), stacks: tr.stacks });
  }
  return out;
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Time covered by `intervals` inside `[start, end]`. */
export function coverage(intervals: Interval[], start: number, end: number): number {
  let total = 0;
  for (const [a, b] of intervals) {
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

export function activeAt(intervals: Interval[], t: number): boolean {
  return intervals.some(([a, b]) => t >= a && t < b);
}

export function stacksAt(track: AuraTrack | undefined, t: number): number {
  if (!track) return 0;
  let s = 0;
  for (const [at, n] of track.stacks) {
    if (at > t) break;
    s = n;
  }
  return activeAt(track.intervals, t) ? Math.max(s, 1) : 0;
}
