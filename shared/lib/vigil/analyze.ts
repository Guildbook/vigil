import { effectiveHeal, isDamage, isHeal, isHostileNpc } from "@/lib/combatlog/events";
import { FightSplitter, type Fight, type SplitterOptions } from "@/lib/combatlog/fights";
import { splitLines } from "@/lib/combatlog/lines";
import { computeMetrics, DEFAULT_OFF_GCD, POWER, type FightMetrics } from "@/lib/combatlog/metrics";
import { LogReader, PlayerScanner, type LogScan } from "@/lib/combatlog/scan";
import type { CombatEvent, LogHeader } from "@/lib/combatlog/types";
import {
  adherence,
  cooldownUsage,
  FightState,
  gatherLogFacts,
  indexModel,
  makeThreatFn,
  observedGcd,
  procUsage,
  rageDump,
  readyIdle,
  replay,
  sealCadence,
  uptimes,
  type LogFacts,
  type ModelIndex,
} from "./rotations/engine";
import { getModel } from "./rotations";
import { REPORT_VERSION, type FightReport } from "./report";
import { snapshotFor, type VigilSnapshot } from "./saved-variables";

const POWER_NAMES: Record<number, string> = { [POWER.mana]: "Mana", [POWER.rage]: "Rage", [POWER.focus]: "Focus", [POWER.energy]: "Energy" };

export interface AnalyzeOptions {
  playerGuid: string;
  playerName: string;
  modelId: string | null;
  header: LogHeader;
  snapshots?: VigilSnapshot[];
}

export function playerLevel(fights: Fight[], guid: string): number | null {
  let level: number | null = null;
  for (const f of fights) for (const ev of f.events) if (ev.adv?.guid === guid && ev.adv.level) level = Math.max(level ?? 0, ev.adv.level);
  return level;
}

const genericThreat = (guid: string) => (ev: CombatEvent) => {
  if (ev.src?.guid !== guid) return 0;
  if (isDamage(ev)) return isHostileNpc(ev.dst) ? (ev.amount ?? 0) : 0;
  if (isHeal(ev)) return effectiveHeal(ev) * 0.5;
  return 0;
};

/** Turns the player's fights into uploadable reports, one per fight. */
export function buildReports(fights: Fight[], opts: AnalyzeOptions): FightReport[] {
  const model = getModel(opts.modelId);
  const level = playerLevel(fights, opts.playerGuid);
  const idx = model ? indexModel(model) : null;
  const facts = idx ? gatherLogFacts(idx, fights, opts.playerGuid, level) : null;
  return fights.map((fight) => analyzeFight(fight, opts, level, idx, facts).report);
}

export interface FightAnalysis {
  report: FightReport;
  /** The engine's view of the fight; null without a rotation model. */
  state: FightState | null;
  metrics: FightMetrics;
  gcdMs: number;
}

/**
 * One fight analysed in the light of `context` (other fights from the same log, which teach the engine
 * cooldowns, costs and known spells). Live tailing calls this on the fight in progress.
 */
export function analyzeFightInContext(fight: Fight, context: Fight[], opts: AnalyzeOptions): FightAnalysis {
  const model = getModel(opts.modelId);
  const all = context.includes(fight) ? context : [...context, fight];
  const level = playerLevel(all, opts.playerGuid);
  const idx = model ? indexModel(model) : null;
  const facts = idx ? gatherLogFacts(idx, all, opts.playerGuid, level) : null;
  return analyzeFight(fight, opts, level, idx, facts);
}

function analyzeFight(
  fight: Fight,
  opts: AnalyzeOptions,
  level: number | null,
  idx: ModelIndex | null,
  facts: LogFacts | null,
): FightAnalysis {
  const guid = opts.playerGuid;
  const model = idx?.model ?? null;
  const notes: string[] = [];
  if (!opts.header.version) notes.push("No COMBAT_LOG_VERSION header was found, so the retail line layout was assumed.");
  if (!opts.header.advanced) notes.push("Advanced combat logging was off: rage, mana and positions are missing.");

  const offGcd = new Set(DEFAULT_OFF_GCD);
  const nextSwing = new Set(["heroic strike", "cleave", "maul", "raptor strike"]);
  for (const s of model?.spells ?? []) {
    for (const n of s.names) {
      if (s.gcd) offGcd.delete(n.toLowerCase());
      else offGcd.add(n.toLowerCase());
      if (s.nextSwing) nextSwing.add(n.toLowerCase());
    }
  }
  const powerType = model?.resource ? POWER[model.resource] : undefined;
  const firstPass = computeMetrics(fight, guid, { offGcd, nextSwing, powerType });
  const gcdMs = observedGcd(firstPass.casts);

  let metrics: FightMetrics;
  let state: FightState | null = null;
  if (idx && facts) {
    state = new FightState(idx, fight, guid, facts, firstPass);
    const s = state;
    const stanceKey = idx.model.threat.stanceAura;
    const threatOf = makeThreatFn(idx, facts, guid, level, (t) => (stanceKey ? s.auraActive(stanceKey, t, null) : true));
    metrics = computeMetrics(fight, guid, { gcdMs, offGcd, nextSwing, powerType, threatOf });
  } else {
    metrics = computeMetrics(fight, guid, { gcdMs, offGcd, nextSwing, threatOf: genericThreat(guid) });
  }

  const duration = metrics.durationMs;
  const seconds = duration / 1000;
  const adh = state ? adherence(state) : null;
  const idle = state ? readyIdle(state, gcdMs) : null;
  const ups = state ? uptimes(state) : [];
  const procs = state ? procUsage(state) : [];
  const cds = state ? cooldownUsage(state, procs) : [];
  const dump = state && model?.extras.includes("rageDump") ? rageDump(state, model.rageDumpAt ?? 60) : undefined;
  const seal = state && model?.extras.includes("sealCadence") ? sealCadence(state) : undefined;
  const lostSwings = model?.extras.includes("swingContinuity") ? (metrics.swings?.lostSwings ?? 0) : 0;
  const estimate = state ? replay(state, metrics, gcdMs, { lostSwings, rageDump: dump }) : null;

  const resource = metrics.resource;
  const incomePerMs = resource && duration ? resource.gained / duration : 0;

  const parts: { label: string; value: number }[] = [];
  if (estimate) parts.push({ label: "Output vs estimate", value: estimate.efficiency });
  if (adh && adh.decisions >= 3) parts.push({ label: "Priority adherence", value: adh.pct });
  if (idle) parts.push({ label: "Time on task", value: Math.max(0, 1 - idle.ms / duration) });
  else parts.push({ label: "GCD usage", value: Math.min(1, metrics.activeMs / duration) });
  const scored = ups.filter((u) => u.scored);
  if (scored.length) {
    parts.push({ label: "Uptimes", value: scored.reduce((a, u) => a + Math.min(1, u.pct / (u.targetPct || 1)), 0) / scored.length });
  }
  const usableProcs = procs.filter((p) => p.usable > 0);
  if (usableProcs.length) parts.push({ label: "Proc usage", value: usableProcs.reduce((a, p) => a + p.pct, 0) / usableProcs.length });
  const overall = Math.round((parts.reduce((a, p) => a + p.value, 0) / Math.max(1, parts.length)) * 100);

  const report: FightReport = {
    version: REPORT_VERSION,
    fight: {
      label: fight.label.slice(0, 120),
      kind: fight.kind,
      encounter: fight.encounter
        ? {
            id: fight.encounter.id,
            name: fight.encounter.name.slice(0, 120),
            difficulty: fight.encounter.difficulty,
            success: fight.encounter.success,
          }
        : undefined,
      startedAt: new Date(fight.startT).toISOString(),
      durationMs: Math.max(1, Math.round(duration)),
      targets: fight.targets.slice(0, 25).map((t) => ({
        name: t.name.slice(0, 120),
        npcId: t.npcId,
        damageTaken: t.damageTaken,
        damageDealt: t.damageDealt,
        died: t.died,
      })),
    },
    player: { name: opts.playerName.slice(0, 120), guid: guid.slice(0, 64), level },
    log: { version: opts.header.version, advanced: opts.header.advanced, build: opts.header.build, projectId: opts.header.projectId },
    model: model ? { id: model.id, label: model.label, metric: model.metric } : null,
    totals: {
      damage: metrics.damage,
      healing: metrics.healing,
      overheal: metrics.overheal,
      damageTaken: metrics.damageTaken,
      threat: Math.round(metrics.threat),
      dps: round1(metrics.damage / seconds),
      hps: round1(metrics.healing / seconds),
      tps: round1(metrics.threat / seconds),
    },
    activity: {
      gcdMs,
      gcdCasts: metrics.gcdCasts,
      activeMs: Math.round(metrics.activeMs),
      gcdUsage: Math.min(1, metrics.activeMs / duration),
      readyIdleMs: idle ? idle.ms : null,
      idleGaps: (idle ? idle.gaps : metrics.idleGaps).slice(0, 200).map(roundInterval),
    },
    casts: metrics.casts.map((c, i) => ({
      t: Math.max(0, Math.round(c.t)),
      name: c.name.slice(0, 120),
      gcd: c.gcd,
      verdict: adh?.verdicts.get(i),
    })),
    spells: metrics.spells.slice(0, 80).map((s) => ({ ...s, name: s.name.slice(0, 120), threat: Math.round(s.threat) })),
    adherence: adh ? { pct: adh.pct, decisions: adh.decisions, matched: adh.matched, steps: adh.steps, misses: adh.misses } : null,
    uptimes: ups.slice(0, 20).map((u) => ({ ...u, intervals: u.intervals.map(roundInterval) })),
    procs,
    cooldowns: cds,
    swings: metrics.swings,
    resource: resource
      ? {
          name: POWER_NAMES[resource.powerType] ?? "Power",
          max: resource.max,
          samples: resource.samples.map(([t, v]) => [Math.max(0, Math.round(t)), v]),
          timeAtCapMs: Math.round(resource.timeAtCapMs),
          wastedEstimate: Math.round(resource.timeAtCapMs * incomePerMs + resource.overEnergize),
          gained: Math.round(resource.gained),
          spent: Math.round(resource.spent),
        }
      : null,
    extras: { rageDump: dump, seal },
    estimate,
    score: { overall, parts },
    snapshot: opts.snapshots?.length ? snapshotFor(opts.snapshots, opts.playerName, fight.startT) : null,
    notes,
  };
  return { report, state, metrics, gcdMs };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const roundInterval = ([a, b]: [number, number]): [number, number] => [Math.max(0, Math.round(a)), Math.max(0, Math.round(b))];

/** Scan a whole log held in memory (tests, small logs). The worker streams instead. */
export function scanText(text: string, fallbackYear?: number): LogScan {
  const reader = new LogReader(fallbackYear);
  const scanner = new PlayerScanner();
  for (const line of splitLines(text)) {
    const ev = reader.read(line);
    if (ev) scanner.push(ev);
  }
  return scanner.result(reader);
}

export function splitText(text: string, playerGuid: string, opts?: SplitterOptions & { fallbackYear?: number }) {
  const reader = new LogReader(opts?.fallbackYear);
  const splitter = new FightSplitter(playerGuid, opts);
  for (const line of splitLines(text)) {
    const ev = reader.read(line);
    if (ev) splitter.push(ev);
  }
  return { header: reader.header, fights: splitter.finish() };
}

export function analyzeText(text: string, playerGuid: string, modelId: string | null, playerName = "Player"): FightReport[] {
  const { header, fights } = splitText(text, playerGuid);
  return buildReports(fights, { playerGuid, playerName, modelId, header });
}
