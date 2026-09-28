import { mergeIntervals, coverage, type Interval } from "./auras";
import { abilityName, effectiveHeal, isCastSuccess, isDamage, isHeal, isMiss } from "./events";
import type { Fight } from "./fights";
import type { CombatEvent } from "./types";

/** Power types as written in the log (Enum.PowerType). */
export const POWER = { mana: 0, rage: 1, focus: 2, energy: 3 } as const;

export interface SpellStat {
  name: string;
  spellId: number | null;
  casts: number;
  hits: number;
  crits: number;
  misses: number;
  damage: number;
  healing: number;
  overheal: number;
  threat: number;
}

export interface CastMark {
  /** Milliseconds from fight start. */
  t: number;
  name: string;
  gcd: boolean;
}

export interface ResourceTrack {
  powerType: number;
  max: number;
  /** [ms from fight start, value], downsampled. */
  samples: [number, number][];
  timeAtCapMs: number;
  gained: number;
  spent: number;
  overEnergize: number;
}

export interface SwingStats {
  count: number;
  medianIntervalMs: number;
  /** Swings that would have landed if auto-attack had not stopped (long gaps, counted in median intervals). */
  lostSwings: number;
}

export interface FightMetrics {
  durationMs: number;
  damage: number;
  healing: number;
  overheal: number;
  damageTaken: number;
  threat: number;
  gcdCasts: number;
  /** Time spent on the global cooldown or casting. */
  activeMs: number;
  idleGaps: Interval[];
  spells: SpellStat[];
  casts: CastMark[];
  swings: SwingStats | null;
  resource: ResourceTrack | null;
}

export interface MetricOptions {
  gcdMs?: number;
  /** Abilities that do not trigger the global cooldown (lowercased names). */
  offGcd?: Set<string>;
  /** Abilities that replace the next white swing (Heroic Strike, Maul, Raptor Strike). */
  nextSwing?: Set<string>;
  threatOf?: (ev: CombatEvent) => number;
  powerType?: number;
  /** Idle gaps shorter than this are ignored. */
  minIdleGapMs?: number;
}

export const DEFAULT_OFF_GCD = new Set([
  "heroic strike",
  "cleave",
  "maul",
  "raptor strike",
  "bloodrage",
  "shield block",
  "attack",
  "auto shot",
  "shoot",
]);

export function computeMetrics(fight: Fight, playerGuid: string, opts: MetricOptions = {}): FightMetrics {
  const gcdMs = opts.gcdMs ?? 1500;
  const offGcd = opts.offGcd ?? DEFAULT_OFF_GCD;
  const nextSwing = opts.nextSwing ?? new Set(["heroic strike", "cleave", "maul", "raptor strike"]);
  const minIdle = opts.minIdleGapMs ?? 2500;
  const start = fight.startT;
  const end = fight.endT;
  const spells = new Map<string, SpellStat>();
  const stat = (ev: CombatEvent) => {
    const name = abilityName(ev);
    let s = spells.get(name);
    if (!s) {
      s = { name, spellId: ev.spellId ?? null, casts: 0, hits: 0, crits: 0, misses: 0, damage: 0, healing: 0, overheal: 0, threat: 0 };
      spells.set(name, s);
    }
    return s;
  };

  let damage = 0;
  let healing = 0;
  let overheal = 0;
  let damageTaken = 0;
  let threat = 0;
  const casts: CastMark[] = [];
  const busy: Interval[] = [];
  const castStarts = new Map<string, number>();
  const swingTimes: number[] = [];
  const samples: [number, number][] = [];
  let resourceType = opts.powerType ?? null;
  let resourceMax = 0;
  let overEnergize = 0;

  for (const ev of fight.events) {
    const fromMe = ev.src?.guid === playerGuid;
    const toMe = ev.dst?.guid === playerGuid;

    if (ev.adv && ev.adv.guid === playerGuid && ev.adv.power && ev.adv.powerType) {
      if (resourceType === null) resourceType = ev.adv.powerType[0] ?? null;
      const i = ev.adv.powerType.indexOf(resourceType ?? -1);
      if (i !== -1) {
        let value = ev.adv.power[i] ?? 0;
        let max = ev.adv.maxPower?.[i] ?? 0;
        if (resourceType === POWER.rage && max >= 1000) {
          value /= 10;
          max /= 10;
        }
        resourceMax = Math.max(resourceMax, max);
        samples.push([ev.t - start, value]);
      }
    }

    if (toMe && isDamage(ev)) damageTaken += ev.amount ?? 0;
    if (!fromMe) continue;

    const t = opts.threatOf?.(ev) ?? 0;
    if (t) {
      threat += t;
      stat(ev).threat += t;
    }

    if (isDamage(ev)) {
      const s = stat(ev);
      s.hits++;
      if (ev.critical) s.crits++;
      s.damage += ev.amount ?? 0;
      damage += ev.amount ?? 0;
    } else if (isMiss(ev)) {
      stat(ev).misses++;
    } else if (isHeal(ev)) {
      const s = stat(ev);
      const eff = effectiveHeal(ev);
      s.hits++;
      if (ev.critical) s.crits++;
      s.healing += eff;
      s.overheal += ev.overheal ?? 0;
      healing += eff;
      overheal += ev.overheal ?? 0;
    } else if (ev.type.endsWith("_ENERGIZE") && ev.powerType === resourceType) {
      overEnergize += ev.overEnergize ?? 0;
    }

    if (ev.type === "SPELL_CAST_START" && ev.spellName) castStarts.set(ev.spellName, ev.t);
    if (isCastSuccess(ev) && ev.spellName) {
      const name = ev.spellName;
      const gcd = !offGcd.has(name.toLowerCase());
      stat(ev).casts++;
      casts.push({ t: ev.t - start, name, gcd });
      const castStart = castStarts.get(name);
      castStarts.delete(name);
      if (gcd) {
        const from = castStart !== undefined && ev.t - castStart < 10_000 ? castStart : ev.t;
        busy.push([from, Math.max(ev.t, from + gcdMs)]);
      }
    }

    const mainHandSwing = (ev.type === "SWING_DAMAGE" || ev.type === "SWING_MISSED") && !ev.offHand;
    const replacedSwing =
      (ev.type === "SPELL_DAMAGE" || ev.type === "SPELL_MISSED") && nextSwing.has((ev.spellName ?? "").toLowerCase());
    if (mainHandSwing || replacedSwing) swingTimes.push(ev.t);
  }

  const merged = mergeIntervals(busy);
  const activeMs = coverage(merged, start, end);
  const idleGaps: Interval[] = [];
  let cursor = start;
  for (const [a, b] of merged) {
    if (a - cursor >= minIdle) idleGaps.push([cursor - start, a - start]);
    cursor = Math.max(cursor, b);
  }
  if (end - cursor >= minIdle) idleGaps.push([cursor - start, end - start]);

  return {
    durationMs: Math.max(1, end - start),
    damage,
    healing,
    overheal,
    damageTaken,
    threat,
    gcdCasts: busy.length,
    activeMs,
    idleGaps,
    spells: [...spells.values()].sort((a, b) => b.damage + b.healing + b.threat - (a.damage + a.healing + a.threat)),
    casts: casts.slice(0, 3000),
    swings: swingStats(swingTimes),
    resource: resourceType === null || samples.length === 0 ? null : resourceTrack(resourceType, resourceMax, samples, end - start, overEnergize),
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function swingStats(times: number[]): SwingStats | null {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  if (sorted.length < 5) return null;
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!);
  const med = median(gaps);
  if (med <= 0) return null;
  let lost = 0;
  for (const g of gaps) if (g > med * 1.5) lost += Math.round(g / med) - 1;
  return { count: sorted.length, medianIntervalMs: Math.round(med), lostSwings: lost };
}

function resourceTrack(
  powerType: number,
  max: number,
  raw: [number, number][],
  durationMs: number,
  overEnergize: number,
): ResourceTrack {
  const sorted = [...raw].sort((a, b) => a[0] - b[0]);
  let gained = 0;
  let spent = 0;
  let atCap = 0;
  for (let i = 0; i < sorted.length; i++) {
    const [t, v] = sorted[i]!;
    const next = sorted[i + 1];
    if (next) {
      const d = next[1] - v;
      if (d > 0) gained += d;
      else spent -= d;
    }
    if (max > 0 && v >= max * 0.98) atCap += Math.min((next?.[0] ?? durationMs) - t, 3000);
  }
  const step = Math.max(1, Math.ceil(sorted.length / 400));
  return {
    powerType,
    max,
    samples: sorted.filter((_, i) => i % step === 0),
    timeAtCapMs: Math.max(0, atCap),
    gained,
    spent,
    overEnergize,
  };
}
