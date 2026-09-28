import { activeAt, coverage, mergeIntervals, stacksAt, trackAuras, type AuraTrack, type Interval } from "@/lib/combatlog/auras";
import { effectiveHeal, isDamage, isHeal, isHostileNpc, isMiss } from "@/lib/combatlog/events";
import type { Fight } from "@/lib/combatlog/fights";
import { DEFAULT_OFF_GCD, median, POWER, type FightMetrics } from "@/lib/combatlog/metrics";
import type { CombatEvent } from "@/lib/combatlog/types";
import type { AuraDef, Condition, LevelTable, PriorityRule, RotationModel, SpellDef } from "./types";

export function levelValue(table: LevelTable | undefined, level: number | null): number {
  if (!table || table.length === 0) return 0;
  if (level === null) return table[table.length - 1]![1];
  let value = table[0]![1];
  for (const [min, v] of table) if (level >= min) value = v;
  return value;
}

export interface ModelIndex {
  model: RotationModel;
  spellByName: Map<string, SpellDef>;
  /** Cast names and effect names (Judgement of Righteousness belongs to Judgement). */
  spellByAnyName: Map<string, SpellDef>;
  spellByKey: Map<string, SpellDef>;
  auraByName: Map<string, AuraDef>;
  prioritySpells: Set<string>;
}

export function indexModel(model: RotationModel): ModelIndex {
  const spellByName = new Map<string, SpellDef>();
  for (const s of model.spells) for (const n of s.names) spellByName.set(n.toLowerCase(), s);
  const spellByAnyName = new Map(spellByName);
  for (const s of model.spells) for (const n of s.effectNames ?? []) spellByAnyName.set(n.toLowerCase(), s);
  const auraByName = new Map<string, AuraDef>();
  for (const a of model.auras) for (const n of a.names) auraByName.set(n.toLowerCase(), a);
  const prioritySpells = new Set<string>();
  for (const r of model.priority) {
    prioritySpells.add(r.spell);
    for (const a of r.accepts ?? []) prioritySpells.add(a);
  }
  return { model, spellByName, spellByAnyName, spellByKey: new Map(model.spells.map((s) => [s.key, s])), auraByName, prioritySpells };
}

export const spellOf = (idx: ModelIndex, ev: CombatEvent) =>
  ev.spellName ? idx.spellByName.get(ev.spellName.toLowerCase()) : undefined;

/** The model spell an event's damage or healing counts towards, including effect names. */
export const spellForValue = (idx: ModelIndex, ev: CombatEvent) =>
  ev.spellName ? idx.spellByAnyName.get(ev.spellName.toLowerCase()) : undefined;

/** Facts gathered across the whole log for one player before any fight is scored. */
export interface LogFacts {
  /** Spell keys the player cast at least once: the model never expects a spell you have not shown you know. */
  known: Set<string>;
  /** Cooldowns, shortened when the log shows faster reuse (talents, Forever changes). */
  cooldowns: Map<string, number>;
  /** Whether `mayConsume` spells really remove their aura in this game version. */
  consumes: Map<string, boolean>;
  /** Median resource cost per cast, from advanced logging. */
  costs: Map<string, number>;
  stanceSeen: boolean;
  /** Log-wide per-cast values, used when a fight has no casts of a spell. */
  perCast: Map<string, { damage: number; threat: number; healing: number }>;
}

export function gatherLogFacts(idx: ModelIndex, fights: Fight[], playerGuid: string, level: number | null): LogFacts {
  const { model } = idx;
  const known = new Set<string>();
  const castTimes = new Map<string, number[]>();
  const costSamples = new Map<string, number[]>();
  const consumeHits = new Map<string, { casts: number; consumed: number }>();
  let stanceSeen = false;
  const stanceNames = new Set(
    model.auras.find((a) => a.key === model.threat.stanceAura)?.names.map((n) => n.toLowerCase()) ?? [],
  );

  for (const fight of fights) {
    const events = fight.events;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type.startsWith("SPELL_AURA_") && stanceNames.has((ev.spellName ?? "").toLowerCase())) stanceSeen = true;
      if (ev.src?.guid !== playerGuid) continue;
      const spell = spellOf(idx, ev);
      if (!spell) continue;
      // Next-swing abilities may only show up as damage or misses.
      if (isDamage(ev) || isMiss(ev)) known.add(spell.key);
      if (ev.type !== "SPELL_CAST_SUCCESS") continue;
      known.add(spell.key);
      castTimes.set(spell.key, [...(castTimes.get(spell.key) ?? []), ev.t]);
      if (ev.adv?.guid === playerGuid && ev.adv.powerCost) {
        const rageIndex = ev.adv.powerType?.indexOf(POWER.rage) ?? -1;
        const tenths = model.resource === "rage" && rageIndex !== -1 && (ev.adv.maxPower?.[rageIndex] ?? 0) >= 1000;
        const cost = tenths ? ev.adv.powerCost / 10 : ev.adv.powerCost;
        costSamples.set(spell.key, [...(costSamples.get(spell.key) ?? []), cost]);
      }
      if (spell.mayConsume) {
        const group = spell.mayConsume;
        const names = new Set(
          model.auras.filter((a) => a.key === group || a.group === group).flatMap((a) => a.names.map((x) => x.toLowerCase())),
        );
        const hit = consumeHits.get(spell.key) ?? { casts: 0, consumed: 0 };
        hit.casts++;
        for (let j = i + 1; j < events.length && events[j]!.t - ev.t <= 600; j++) {
          const e = events[j]!;
          if (e.type === "SPELL_AURA_REMOVED" && e.dst?.guid === playerGuid && names.has((e.spellName ?? "").toLowerCase())) {
            hit.consumed++;
            break;
          }
        }
        consumeHits.set(spell.key, hit);
      }
    }
  }

  const cooldowns = new Map<string, number>();
  for (const s of model.spells) {
    if (!s.cooldownMs) continue;
    const times = (castTimes.get(s.key) ?? []).sort((a, b) => a - b);
    let fastest = Infinity;
    for (let i = 1; i < times.length; i++) fastest = Math.min(fastest, times[i]! - times[i - 1]!);
    cooldowns.set(s.key, fastest >= 1000 && fastest < s.cooldownMs ? fastest : s.cooldownMs);
  }
  const consumes = new Map<string, boolean>();
  for (const [key, hit] of consumeHits) consumes.set(key, hit.casts > 0 && hit.consumed / hit.casts >= 0.5);
  const costs = new Map<string, number>();
  for (const [key, list] of costSamples) costs.set(key, median(list));

  const facts: LogFacts = { known, cooldowns, consumes, costs, stanceSeen, perCast: new Map() };
  const totals = new Map<string, { casts: number; damage: number; threat: number; healing: number }>();
  for (const fight of fights) {
    const threatOf = makeThreatFn(idx, facts, playerGuid, level, () => true);
    for (const ev of fight.events) {
      if (ev.src?.guid !== playerGuid) continue;
      const spell = spellForValue(idx, ev);
      if (!spell) continue;
      const t = totals.get(spell.key) ?? { casts: 0, damage: 0, threat: 0, healing: 0 };
      if (ev.type === "SPELL_CAST_SUCCESS" && spellOf(idx, ev) === spell) t.casts++;
      if (isDamage(ev)) t.damage += ev.amount ?? 0;
      if (isHeal(ev)) t.healing += effectiveHeal(ev);
      t.threat += threatOf(ev);
      totals.set(spell.key, t);
    }
  }
  for (const [key, t] of totals) {
    if (t.casts > 0) facts.perCast.set(key, { damage: t.damage / t.casts, threat: t.threat / t.casts, healing: t.healing / t.casts });
  }
  return facts;
}

/** Estimated threat for one of the player's events. */
export function makeThreatFn(
  idx: ModelIndex,
  facts: Pick<LogFacts, "stanceSeen">,
  playerGuid: string,
  level: number | null,
  stanceActive: (t: number) => boolean,
): (ev: CombatEvent) => number {
  const { threat } = idx.model;
  return (ev) => {
    if (ev.src?.guid !== playerGuid) return 0;
    const stance = !threat.stanceAura || !facts.stanceSeen || stanceActive(ev.t) ? threat.stanceMultiplier : 1;
    const spell = spellOf(idx, ev);
    if (ev.type.endsWith("_ENERGIZE")) {
      return ev.powerType === POWER.rage ? (ev.amount ?? 0) * (threat.perRageGained ?? 0) : 0;
    }
    if (isHeal(ev)) return effectiveHeal(ev) * threat.healingMultiplier * stance;
    const bonus = levelValue(spell?.threat?.bonus, level);
    const on = spell?.threat?.on ?? "hit";
    if (isDamage(ev)) {
      if (!isHostileNpc(ev.dst)) return 0;
      const dmg = (ev.amount ?? 0) * (spell?.threat?.damageMultiplier ?? 1);
      return (dmg + (on === "hit" ? bonus : 0)) * stance;
    }
    if (ev.type === "SPELL_CAST_SUCCESS" && on === "cast") return bonus * stance;
    if (isMiss(ev) && on === "cast" && ev.type.startsWith("SPELL_")) return -bonus * stance;
    return 0;
  };
}

interface Cast {
  t: number;
  key: string | null;
  name: string;
  gcd: boolean;
  targetGuid: string | null;
  startT: number;
}

/** Observed state of a fight, queried at any time. */
export class FightState {
  readonly casts: Cast[] = [];
  readonly tracks: Map<string, AuraTrack>;
  readonly procTriggers = new Map<string, number[]>();
  private readonly targetPoints: [number, string][] = [];
  readonly start: number;
  readonly end: number;

  constructor(
    readonly idx: ModelIndex,
    readonly fight: Fight,
    readonly playerGuid: string,
    readonly facts: LogFacts,
    readonly metrics: FightMetrics | null,
  ) {
    this.start = fight.startT;
    this.end = fight.endT;
    const targets = new Map(fight.targets.map((t) => [t.guid, t]));
    const castStarts = new Map<string, number>();
    const avoidProcs = idx.model.procs.filter((p) => p.trigger === "avoided");

    for (const ev of fight.events) {
      const fromMe = ev.src?.guid === playerGuid;
      if (fromMe && ev.dst && targets.has(ev.dst.guid) && (isDamage(ev) || isMiss(ev) || ev.type === "SPELL_CAST_SUCCESS")) {
        this.targetPoints.push([ev.t, ev.dst.guid]);
      }
      if (fromMe && ev.type === "SPELL_CAST_START" && ev.spellName) castStarts.set(ev.spellName, ev.t);
      if (fromMe && ev.type === "SPELL_CAST_SUCCESS" && ev.spellName) {
        const spell = spellOf(idx, ev);
        const castStart = castStarts.get(ev.spellName);
        castStarts.delete(ev.spellName);
        this.casts.push({
          t: ev.t,
          key: spell?.key ?? null,
          name: ev.spellName,
          gcd: spell ? spell.gcd : !DEFAULT_OFF_GCD.has(ev.spellName.toLowerCase()),
          targetGuid: ev.dst && targets.has(ev.dst.guid) ? ev.dst.guid : null,
          startT: castStart !== undefined && ev.t - castStart < 10_000 ? castStart : ev.t,
        });
      }
      const avoided =
        ev.dst?.guid === playerGuid &&
        isHostileNpc(ev.src) &&
        ((isMiss(ev) && ["DODGE", "PARRY", "BLOCK"].includes(ev.missType ?? "")) || (isDamage(ev) && (ev.blocked ?? 0) > 0));
      if (avoided) for (const p of avoidProcs) this.procTriggers.set(p.key, [...(this.procTriggers.get(p.key) ?? []), ev.t]);
    }

    const window = (guid: string): Interval => {
      const target = targets.get(guid);
      return target ? [Math.max(this.start, target.firstT), Math.min(this.end, target.lastT)] : [this.start, this.end];
    };
    const initial = new Set(
      idx.model.auras
        .filter((a) => a.on === "player" && a.names.some((n) => fight.initialAuras[n.toLowerCase()] !== undefined))
        .map((a) => a.key),
    );
    this.tracks = trackAuras(
      fight.events,
      (ev) => {
        const def = idx.auraByName.get((ev.spellName ?? "").toLowerCase());
        if (!def || !ev.dst) return null;
        if (def.on === "player" && ev.dst.guid !== playerGuid) return null;
        if (def.on === "target" && !targets.has(ev.dst.guid)) return null;
        if (!def.anySource && ev.src?.guid !== playerGuid) return null;
        return def.key;
      },
      window,
      (key, dst) => dst === playerGuid && initial.has(key),
      [...initial].map((key): [string, string] => [key, playerGuid]),
    );
  }

  targetAt(t: number): string | null {
    let found: string | null = null;
    for (const [at, guid] of this.targetPoints) {
      if (at > t) break;
      found = guid;
    }
    return found ?? this.fight.targets[0]?.guid ?? null;
  }

  defsFor(keyOrGroup: string): AuraDef[] {
    return this.idx.model.auras.filter((a) => a.key === keyOrGroup || a.group === keyOrGroup);
  }

  track(def: AuraDef, target: string | null): AuraTrack | undefined {
    const dst = def.on === "player" ? this.playerGuid : target;
    return dst ? this.tracks.get(`${def.key}|${dst}`) : undefined;
  }

  auraActive(keyOrGroup: string, t: number, target: string | null): boolean {
    return this.defsFor(keyOrGroup).some((d) => activeAt(this.track(d, target)?.intervals ?? [], t));
  }

  stacks(key: string, t: number, target: string | null): number {
    return Math.max(0, ...this.defsFor(key).map((d) => stacksAt(this.track(d, target), t)));
  }

  procActive(procKey: string, t: number): boolean {
    const proc = this.idx.model.procs.find((p) => p.key === procKey);
    if (!proc) return false;
    const triggers = this.procTriggers.get(procKey) ?? [];
    let last: number | null = null;
    for (const tr of triggers) {
      if (tr > t) break;
      last = tr;
    }
    if (last === null || t >= last + proc.windowMs) return false;
    return !this.casts.some((c) => c.key === proc.spell && c.t >= last! && c.t < t);
  }

  resourceAt(t: number): number | null {
    const samples = this.metrics?.resource?.samples;
    if (!samples || samples.length === 0) return null;
    const rel = t - this.start;
    let value: number | null = null;
    for (const [at, v] of samples) {
      if (at > rel) break;
      value = v;
    }
    return value ?? samples[0]![1];
  }

  cost(key: string): number {
    return this.facts.costs.get(key) ?? this.idx.spellByKey.get(key)?.cost ?? 0;
  }

  readyAt(key: string, t: number): boolean {
    const cd = this.facts.cooldowns.get(key) ?? 0;
    if (!cd) return true;
    let last: number | null = null;
    for (const c of this.casts) {
      if (c.t >= t) break;
      if (c.key === key) last = c.t;
    }
    return last === null || last + cd <= t + 250;
  }

  conditionHolds(cond: Condition, t: number, target: string | null): boolean {
    switch (cond.kind) {
      case "auraMissing":
        return !this.auraActive(cond.aura, t - 1, target);
      case "auraActive":
        return this.auraActive(cond.aura, t - 1, target);
      case "stacksBelow":
        return this.stacks(cond.aura, t - 1, target) < cond.stacks;
      case "procActive":
        return this.procActive(cond.proc, t);
      case "resourceAtLeast": {
        const r = this.resourceAt(t - 1);
        return r === null || r >= cond.amount;
      }
    }
  }

  /** First priority step that could be used at `t`, from what actually happened. */
  expectedAt(t: number, target: string | null): PriorityRule | null {
    for (const rule of this.idx.model.priority) {
      if (!this.facts.known.has(rule.spell)) continue;
      if (!this.readyAt(rule.spell, t)) continue;
      const r = this.resourceAt(t - 1);
      if (r !== null && r + 1 < this.cost(rule.spell)) continue;
      if ((rule.when ?? []).every((c) => this.conditionHolds(c, t, target))) return rule;
    }
    return null;
  }
}

/** Global cooldown from the player's fastest back-to-back GCD casts, between 1.0 and 1.5 seconds. */
export function observedGcd(casts: { t: number; gcd: boolean }[]): number {
  const times = casts.filter((c) => c.gcd).map((c) => c.t).sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]!).filter((g) => g >= 900 && g <= 2500).sort((a, b) => a - b);
  if (gaps.length < 3) return 1500;
  const p10 = gaps[Math.floor(gaps.length * 0.1)]!;
  return Math.round(Math.min(1500, Math.max(1000, p10)));
}

export interface Adherence {
  pct: number;
  decisions: number;
  matched: number;
  steps: { label: string; expected: number; done: number }[];
  misses: { t: number; expected: string; actual: string }[];
  verdicts: Map<number, "match" | "miss" | "outside">;
}

export function adherence(state: FightState): Adherence {
  const { idx } = state;
  const steps = new Map(idx.model.priority.map((r) => [r.label, { label: r.label, expected: 0, done: 0 }]));
  const misses: Adherence["misses"] = [];
  const verdicts = new Map<number, "match" | "miss" | "outside">();
  let decisions = 0;
  let matched = 0;
  state.casts.forEach((c, i) => {
    if (!c.gcd) return;
    if (!c.key || !idx.prioritySpells.has(c.key)) {
      verdicts.set(i, "outside");
      return;
    }
    const rule = state.expectedAt(c.startT, c.targetGuid ?? state.targetAt(c.t));
    if (!rule) return;
    decisions++;
    const step = steps.get(rule.label)!;
    step.expected++;
    if (c.key === rule.spell || rule.accepts?.includes(c.key)) {
      matched++;
      step.done++;
      verdicts.set(i, "match");
    } else {
      verdicts.set(i, "miss");
      if (misses.length < 60) misses.push({ t: c.t - state.start, expected: rule.label, actual: c.name });
    }
  });
  return {
    pct: decisions ? matched / decisions : 0,
    decisions,
    matched,
    steps: [...steps.values()].filter((s) => s.expected > 0),
    misses,
    verdicts,
  };
}

/** Time off the global cooldown while a priority step was ready, beyond a 300 ms reaction allowance. */
export function readyIdle(state: FightState, gcdMs: number): { ms: number; gaps: Interval[] } {
  const busy = mergeIntervals(state.casts.filter((c) => c.gcd).map((c): Interval => [c.startT, Math.max(c.t, c.startT + gcdMs)]));
  const step = 100;
  const reaction = 300;
  let ms = 0;
  let run = 0;
  let runStart = 0;
  const gaps: Interval[] = [];
  let bi = 0;
  for (let t = state.start; t < state.end; t += step) {
    while (bi < busy.length && busy[bi]![1] <= t) bi++;
    const isBusy = bi < busy.length && busy[bi]![0] <= t;
    const ready = !isBusy && state.expectedAt(t, state.targetAt(t)) !== null;
    if (ready) {
      if (run === 0) runStart = t;
      run += step;
      if (run > reaction) ms += step;
    } else {
      if (run > reaction + 500) gaps.push([runStart - state.start, t - state.start]);
      run = 0;
    }
  }
  if (run > reaction + 500) gaps.push([runStart - state.start, state.end - state.start]);
  return { ms, gaps };
}

export interface UptimeRow {
  key: string;
  label: string;
  on: "player" | "target";
  pct: number;
  targetPct: number;
  scored: boolean;
  intervals: Interval[];
}

export function uptimes(state: FightState): UptimeRow[] {
  const { fight, idx } = state;
  const duration = Math.max(1, state.end - state.start);
  const rows: UptimeRow[] = [];
  const rel = (list: Interval[]) => list.map(([a, b]): Interval => [Math.max(0, a - state.start), Math.max(0, b - state.start)]);

  const groups = new Set(idx.model.auras.map((a) => a.group).filter((g): g is string => Boolean(g)));
  for (const def of idx.model.auras) {
    if (def.on === "player") {
      const intervals = state.tracks.get(`${def.key}|${state.playerGuid}`)?.intervals ?? [];
      if (!def.scored && intervals.length === 0) continue;
      rows.push({
        key: def.key,
        label: def.label,
        on: "player",
        pct: Math.min(1, coverage(intervals, state.start, state.end) / duration),
        targetPct: def.targetUptime ?? 1,
        scored: Boolean(def.scored),
        intervals: rel(intervals).slice(0, 400),
      });
    } else {
      let covered = 0;
      let total = 0;
      for (const target of fight.targets) {
        const lo = Math.max(state.start, target.firstT);
        const hi = Math.min(state.end, target.lastT);
        if (hi <= lo) continue;
        total += hi - lo;
        covered += coverage(state.tracks.get(`${def.key}|${target.guid}`)?.intervals ?? [], lo, hi);
      }
      const main = fight.targets[0];
      const intervals = main ? (state.tracks.get(`${def.key}|${main.guid}`)?.intervals ?? []) : [];
      if (!def.scored && covered === 0) continue;
      if (def.scored && !state.facts.known.has(def.appliedBy ?? "") && covered === 0) continue;
      rows.push({
        key: def.key,
        label: `${def.label} (targets)`,
        on: "target",
        pct: total ? Math.min(1, covered / total) : 0,
        targetPct: def.targetUptime ?? 1,
        scored: Boolean(def.scored),
        intervals: rel(intervals).slice(0, 400),
      });
    }
  }
  for (const group of groups) {
    const members = idx.model.auras.filter((a) => a.group === group && a.on === "player");
    if (members.length < 2) continue;
    const union = mergeIntervals(members.flatMap((d) => state.tracks.get(`${d.key}|${state.playerGuid}`)?.intervals ?? []));
    rows.push({
      key: group,
      label: `Any ${group}`,
      on: "player",
      pct: Math.min(1, coverage(union, state.start, state.end) / duration),
      targetPct: 1,
      scored: false,
      intervals: rel(union).slice(0, 400),
    });
  }
  return rows;
}

/**
 * Proc usage: casts of the proc ability against the most it could have been used, given when the procs
 * happened and its cooldown.
 */
export function procUsage(state: FightState) {
  return state.idx.model.procs
    .filter((p) => state.facts.known.has(p.spell))
    .map((proc) => {
      const triggers = state.procTriggers.get(proc.key) ?? [];
      const cd = state.facts.cooldowns.get(proc.spell) ?? 0;
      let possible = 0;
      let nextReady = -Infinity;
      let consumedTrigger = -Infinity;
      for (const tr of triggers) {
        if (tr <= consumedTrigger) continue;
        const at = Math.max(tr, nextReady);
        if (at < tr + proc.windowMs && at <= state.end) {
          possible++;
          nextReady = at + cd;
          consumedTrigger = at;
        }
      }
      const used = state.casts.filter(
        (c) => c.key === proc.spell && triggers.some((tr) => c.t >= tr && c.t <= tr + proc.windowMs),
      ).length;
      const usable = Math.max(possible, used);
      return { key: proc.key, label: proc.label, windows: triggers.length, usable, used, pct: usable ? used / usable : 0 };
    });
}

export function cooldownUsage(state: FightState, procs: ReturnType<typeof procUsage>) {
  const duration = state.end - state.start;
  return state.idx.model.spells
    .filter((s) => s.trackCooldown && state.facts.known.has(s.key))
    .map((s) => {
      const cd = state.facts.cooldowns.get(s.key) ?? s.cooldownMs ?? 0;
      const casts = state.casts.filter((c) => c.key === s.key).length;
      let possible = cd ? Math.floor(duration / cd) + 1 : casts;
      const proc = state.idx.model.procs.find((p) => p.spell === s.key);
      if (proc) possible = Math.min(possible, procs.find((p) => p.key === proc.key)?.usable ?? possible);
      possible = Math.max(possible, casts);
      return { key: s.key, label: s.label, casts, possible, pct: possible ? Math.min(1, casts / possible) : 0 };
    });
}

export function rageDump(state: FightState, threshold: number) {
  if (!state.facts.known.has("heroic-strike")) return undefined;
  const hs = state.idx.spellByKey.get("heroic-strike")!;
  const hsNames = new Set(hs.names.map((n) => n.toLowerCase()));
  const max = state.metrics?.resource?.max || 100;
  const scaled = (threshold * max) / 100;
  let opportunities = 0;
  let used = 0;
  for (const ev of state.fight.events) {
    if (ev.src?.guid !== state.playerGuid) continue;
    const swing = (ev.type === "SWING_DAMAGE" || ev.type === "SWING_MISSED") && !ev.offHand;
    const isHs = (isDamage(ev) || isMiss(ev)) && hsNames.has((ev.spellName ?? "").toLowerCase());
    if (!swing && !isHs) continue;
    const rage = state.resourceAt(ev.t - 1);
    if (rage === null || rage < scaled) continue;
    opportunities++;
    if (isHs) used++;
  }
  return { threshold: scaled, opportunities, used, pct: opportunities ? used / opportunities : 1 };
}

export function sealCadence(state: FightState) {
  const judgements = state.casts.filter((c) => c.key === "judgement").map((c) => c.t);
  const gaps = judgements.slice(1).map((t, i) => t - judgements[i]!);
  const seals = state.defsFor("seal");
  const union = mergeIntervals(seals.flatMap((d) => state.tracks.get(`${d.key}|${state.playerGuid}`)?.intervals ?? []));
  return {
    judgements: judgements.length,
    consumesSeal: state.facts.consumes.get("judgement") ?? false,
    medianJudgementIntervalMs: gaps.length ? Math.round(median(gaps)) : null,
    timeWithoutSealMs: Math.max(0, state.end - state.start - coverage(union, state.start, state.end)),
  };
}

export interface ReplayResult {
  metric: RotationModel["metric"];
  actual: number;
  estimated: number;
  efficiency: number;
  gains: { label: string; amount: number }[];
  simCasts: { label: string; actual: number; simulated: number }[];
  assumptions: string[];
}

/**
 * Tier A replay: the same fight with every global cooldown used the moment it is free, following the
 * priority list. Procs, mob behaviour, casts outside the model and resource income stay as logged.
 */
export function replay(
  state: FightState,
  metrics: FightMetrics,
  gcdMs: number,
  extras: { lostSwings: number; rageDump?: { opportunities: number; used: number } },
): ReplayResult {
  const { idx, facts } = state;
  const model = idx.model;
  const metric = model.metric;
  const value = (s: { damage: number; threat: number; healing: number }) =>
    metric === "threat" ? s.threat : metric === "healing" ? s.healing : s.damage;
  const actual = metric === "threat" ? metrics.threat : metric === "healing" ? metrics.healing : metrics.damage;
  const notes: string[] = [];

  const byName = new Map(metrics.spells.map((s) => [s.name.toLowerCase(), s]));
  const fightStat = (key: string) => {
    const spell = idx.spellByKey.get(key)!;
    const pick = (names: string[]) =>
      names.map((n) => byName.get(n.toLowerCase())).filter((s): s is NonNullable<typeof s> => Boolean(s));
    const stats = pick([...spell.names, ...(spell.effectNames ?? [])]);
    return {
      casts: pick(spell.names).reduce((a, s) => a + s.casts, 0),
      damage: stats.reduce((a, s) => a + s.damage, 0),
      threat: stats.reduce((a, s) => a + s.threat, 0),
      healing: stats.reduce((a, s) => a + s.healing, 0),
    };
  };
  const perCast = (key: string) => {
    const s = fightStat(key);
    if (s.casts > 0) return value(s) / s.casts;
    const log = facts.perCast.get(key);
    return log ? value(log) : 0;
  };

  const resource = metrics.resource;
  const duration = state.end - state.start;
  const income = resource && duration > 0 ? resource.gained / duration : 0;
  let pool = resource ? (resource.samples[0]?.[1] ?? 0) : Infinity;
  const poolMax = resource?.max || Infinity;

  const outside = state.casts.filter((c) => c.gcd && (!c.key || !idx.prioritySpells.has(c.key)));
  let oi = 0;
  const readyAt = new Map<string, number>();
  const simPlayerAuras = new Map<string, number>();
  const simStacks = new Map<string, { stacks: number; until: number }>();
  const simProcUsed = new Map<string, number>();
  const counts = new Map<string, number>();
  const simulated = new Set(model.auras.filter((a) => a.appliedBy).map((a) => a.key));

  const simAuraActive = (keyOrGroup: string, t: number, target: string | null) =>
    state.defsFor(keyOrGroup).some((d) => {
      if (!simulated.has(d.key)) return activeAt(state.track(d, target)?.intervals ?? [], t);
      if (d.on === "player") return (simPlayerAuras.get(d.key) ?? -1) > t;
      return (simStacks.get(`${d.key}|${target}`)?.until ?? -1) > t;
    });
  const simStacksAt = (key: string, t: number, target: string | null) =>
    Math.max(
      0,
      ...state.defsFor(key).map((d) => {
        if (!simulated.has(d.key)) return stacksAt(state.track(d, target), t);
        const s = simStacks.get(`${d.key}|${target}`);
        return s && s.until > t ? s.stacks : 0;
      }),
    );
  const simProc = (procKey: string, t: number) => {
    const proc = model.procs.find((p) => p.key === procKey)!;
    let last: number | null = null;
    for (const tr of state.procTriggers.get(procKey) ?? []) {
      if (tr > t) break;
      last = tr;
    }
    if (last === null || t >= last + proc.windowMs) return false;
    return (simProcUsed.get(procKey) ?? -Infinity) < last;
  };
  const holds = (c: Condition, t: number, target: string | null) => {
    switch (c.kind) {
      case "auraMissing":
        return !simAuraActive(c.aura, t, target);
      case "auraActive":
        return simAuraActive(c.aura, t, target);
      case "stacksBelow":
        return simStacksAt(c.aura, t, target) < c.stacks;
      case "procActive":
        return simProc(c.proc, t);
      case "resourceAtLeast":
        return pool >= c.amount;
    }
  };

  let t = state.start;
  let last = t;
  while (t < state.end) {
    pool = Math.min(poolMax, pool + income * (t - last));
    last = t;
    const nextOutside = outside[oi];
    if (nextOutside && nextOutside.startT <= t) {
      oi++;
      t = Math.max(t, nextOutside.startT) + gcdMs;
      continue;
    }
    const target = state.targetAt(t);
    const rule = model.priority.find(
      (r) =>
        facts.known.has(r.spell) &&
        (readyAt.get(r.spell) ?? 0) <= t &&
        pool + 1 >= state.cost(r.spell) &&
        (r.when ?? []).every((c) => holds(c, t, target)),
    );
    if (!rule) {
      t += 100;
      continue;
    }
    const key = rule.spell;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    readyAt.set(key, t + (facts.cooldowns.get(key) ?? 0));
    if (Number.isFinite(pool)) pool -= state.cost(key);
    for (const proc of model.procs) if (proc.spell === key) simProcUsed.set(proc.key, t);
    for (const def of model.auras) {
      if (def.appliedBy !== key) continue;
      const until = t + (def.durationMs ?? 30_000);
      if (def.on === "player") {
        if (def.group) for (const other of state.defsFor(def.group)) simPlayerAuras.delete(other.key);
        simPlayerAuras.set(def.key, until);
      } else if (target) {
        const id = `${def.key}|${target}`;
        const cur = simStacks.get(id);
        const stacks = Math.min(def.maxStacks ?? 1, (cur && cur.until > t ? cur.stacks : 0) + 1);
        simStacks.set(id, { stacks, until });
      }
    }
    const spell = idx.spellByKey.get(key);
    if (spell?.mayConsume && facts.consumes.get(key)) {
      for (const d of state.defsFor(spell.mayConsume)) simPlayerAuras.delete(d.key);
    }
    t += gcdMs;
  }

  const gains: ReplayResult["gains"] = [];
  const simCasts: ReplayResult["simCasts"] = [];
  let estimated = actual;
  for (const key of idx.prioritySpells) {
    if (!facts.known.has(key)) continue;
    const spell = idx.spellByKey.get(key)!;
    const observed = fightStat(key).casts;
    const sim = counts.get(key) ?? 0;
    if (observed === 0 && sim === 0) continue;
    simCasts.push({ label: spell.label, actual: observed, simulated: sim });
    const per = perCast(key);
    if (per === 0 && sim > 0) notes.push(`${spell.label} has no measured ${metric} per cast in this log, so it adds nothing.`);
    const delta = (sim - observed) * per;
    if (Math.round(delta) !== 0) gains.push({ label: `${spell.label} casts`, amount: Math.round(delta) });
    estimated += delta;
  }

  const melee = byName.get("melee");
  const swings = metrics.swings?.count ?? 0;
  const perSwing = melee && swings ? value(melee) / swings : 0;
  if (extras.lostSwings > 0 && perSwing > 0) {
    const amount = extras.lostSwings * perSwing;
    gains.push({ label: "Auto-attack continuity", amount: Math.round(amount) });
    estimated += amount;
  }
  if (extras.rageDump && facts.known.has("heroic-strike")) {
    const hs = fightStat("heroic-strike");
    const hsHits = metrics.spells.find((s) => s.name.toLowerCase() === "heroic strike");
    const hsPer = hsHits && hsHits.hits + hsHits.misses > 0 ? value(hs) / (hsHits.hits + hsHits.misses) : 0;
    const missed = extras.rageDump.opportunities - extras.rageDump.used;
    const amount = missed * Math.max(0, hsPer - perSwing);
    if (amount > 0) {
      gains.push({ label: "Heroic Strike on high-rage swings", amount: Math.round(amount) });
      estimated += amount;
    }
  }

  estimated = Math.max(estimated, actual);
  gains.sort((a, b) => b.amount - a.amount);
  return {
    metric,
    actual: Math.round(actual),
    estimated: Math.round(estimated),
    efficiency: estimated > 0 ? Math.min(1, actual / estimated) : 1,
    gains: gains.slice(0, 20),
    simCasts,
    assumptions: [
      "Estimate, not a simulation of your character: every global cooldown is used the moment it is free, following the priority list.",
      `Global cooldown ${(gcdMs / 1000).toFixed(2)}s, taken from your fastest back-to-back casts.`,
      `Average ${metric} per cast comes from this fight, or from the rest of the log for abilities you did not use here.`,
      "Procs, mob movement, deaths and casts outside the priority list (taunts, heals, AoE) happen exactly as logged.",
      resource
        ? `${resource.powerType === POWER.rage ? "Rage" : "Resource"} arrives at your observed average rate for the fight.`
        : "No resource data in the log (advanced logging off), so the replay never runs out of rage or mana.",
      "The estimate is never lower than what you actually did.",
      ...model.assumptions,
      ...notes,
    ].slice(0, 20),
  };
}