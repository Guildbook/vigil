import { mergeIntervals, type Interval } from "@/lib/combatlog/auras";
import { FightSplitter, type Fight, type SplitterOptions } from "@/lib/combatlog/fights";
import { FLAGS, isPlayerGuid, shortName } from "@/lib/combatlog/guid";
import { LogReader, PlayerScanner } from "@/lib/combatlog/scan";
import type { CombatEvent, LogHeader } from "@/lib/combatlog/types";
import type { WowClass } from "@/lib/game";
import { analyzeFightInContext, type FightAnalysis } from "./analyze";
import type { FightReport } from "./report";
import { detectModel, getModel, type RotationModel } from "./rotations";

/**
 * Incremental Vigil for a log that is still being written: feed it lines as they arrive and ask for the
 * fight in progress at any moment. Finished fights come out as the same reports the browser upload builds.
 */

export type CalloutKind = "proc" | "idle" | "aura" | "resource" | "priority";

export interface Callout {
  id: string;
  kind: CalloutKind;
  /** Start of the fight it belongs to (epoch ms, log time). */
  fightStartT: number;
  /** When the issue began, in ms from the start of the fight. */
  offsetMs: number;
  text: string;
}

export interface LiveUptime {
  key: string;
  label: string;
  pct: number;
  targetPct: number;
  /** Whether the aura is up right now. */
  active: boolean;
}

export interface LiveFight {
  startT: number;
  label: string;
  kind: "boss" | "trash";
  targets: string[];
  elapsedMs: number;
  score: number;
  gcdUsage: number;
  /** Time since the global cooldown last ended. */
  idleNowMs: number;
  /** Time off the global cooldown while a priority ability was ready (model only). */
  readyIdleMs: number | null;
  metric: RotationModel["metric"];
  /** Damage, threat or healing per second, whichever the model scores. */
  perSecond: number;
  uptimes: LiveUptime[];
}

export interface LivePlayer {
  guid: string;
  name: string;
  level: number | null;
}

export interface CompletedFight {
  report: FightReport;
  callouts: Callout[];
}

export interface LiveSessionOptions {
  /** Analyse this player instead of the one who recorded the log. */
  playerGuid?: string | null;
  /** Use this rotation model instead of detecting one. */
  modelId?: string | null;
  /** The player's class when the site knows the character, to narrow model detection. */
  classFor?: (playerName: string) => WowClass | null | undefined;
  fallbackYear?: number;
  splitter?: Omit<SplitterOptions, "keepFinished">;
  /** Finished fights kept to teach the engine cooldowns and costs. */
  contextFights?: number;
  /** Events held while waiting to learn who recorded the log. */
  bufferLimit?: number;
}

const s1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const s0 = (ms: number) => `${Math.round(ms / 1000)} s`;

export class LiveSession {
  private reader: LogReader;
  private scanner = new PlayerScanner();
  private splitter: FightSplitter | null = null;
  private buffer: CombatEvent[] = [];
  private context: Fight[] = [];
  private completed: CompletedFight[] = [];
  private fresh: Callout[] = [];
  private readonly emitted = new Map<number, Map<string, Callout>>();
  private playerGuid: string | null;
  lastEventT: number | null = null;

  constructor(private readonly opts: LiveSessionOptions = {}) {
    this.reader = new LogReader(opts.fallbackYear);
    this.playerGuid = opts.playerGuid ?? null;
    if (this.playerGuid) this.startSplitter(this.playerGuid);
  }

  get header(): LogHeader {
    return this.reader.header;
  }

  get lines(): number {
    return this.reader.lines;
  }

  get player(): LivePlayer | null {
    if (!this.playerGuid) return null;
    const p = this.scanner.player(this.playerGuid);
    return { guid: this.playerGuid, name: p?.name ?? "Unknown", level: p?.level ?? null };
  }

  /** The model in use: the override, or the best match for the spells the player has cast so far. */
  get model(): RotationModel | null {
    if (this.opts.modelId) return getModel(this.opts.modelId);
    if (!this.playerGuid) return null;
    const p = this.scanner.player(this.playerGuid);
    if (!p) return null;
    const wowClass = this.opts.classFor?.(p.name) ?? null;
    return (wowClass ? detectModel(p.spells, wowClass) : null) ?? detectModel(p.spells);
  }

  pushLines(lines: Iterable<string>) {
    for (const line of lines) this.pushLine(line);
  }

  pushLine(line: string) {
    const header = this.reader.header;
    const ev = this.reader.read(line);
    if (this.reader.header !== header && this.splitter && !this.opts.playerGuid) this.relog();
    if (!ev) return;
    this.lastEventT = ev.t;
    this.scanner.push(ev);
    if (!this.splitter) {
      this.buffer.push(ev);
      if (this.buffer.length > (this.opts.bufferLimit ?? 50_000)) this.buffer.shift();
      const src = ev.src;
      if (src && isPlayerGuid(src.guid) && src.flags & FLAGS.affiliationMine) {
        this.playerGuid = src.guid;
        this.startSplitter(src.guid);
      }
      return;
    }
    this.splitter.push(ev);
    this.collect();
  }

  /** Closes the fight in progress if it has gone quiet by log time `now`. */
  tick(now: number) {
    if (this.splitter?.tick(now)) this.collect();
  }

  /**
   * A new log file began (a fresh /combatlog session, or the old one was truncated): finish the open fight
   * and forget the header and the recorder, which the new file announces again.
   */
  newFile() {
    this.finish();
    this.reader = new LogReader(this.opts.fallbackYear);
    this.scanner = new PlayerScanner();
    this.buffer = [];
    this.playerGuid = this.opts.playerGuid ?? null;
    this.splitter = null;
    if (this.playerGuid) this.startSplitter(this.playerGuid);
  }

  /**
   * A new COMBAT_LOG_VERSION header in the same file: Classic clients append a login (possibly on another
   * character) or a /reload to the open log. Finish the open fight and learn the recorder again.
   */
  private relog() {
    this.finish();
    this.buffer = [];
    this.context = [];
    this.playerGuid = null;
    this.splitter = null;
  }

  /** Closes the open fight now (the log stopped, or the app is quitting). */
  finish() {
    if (!this.splitter) return;
    for (const f of this.splitter.finish()) this.finalize(f);
  }

  /** Fights finished since the last call, with their reports. */
  drainCompleted(): CompletedFight[] {
    const out = this.completed;
    this.completed = [];
    return out;
  }

  /** Callouts raised since the last call, oldest first. */
  drainCallouts(): Callout[] {
    const out = this.fresh;
    this.fresh = [];
    return out;
  }

  /** The fight in progress as of log time `now`, or null between pulls. Raises callouts for what has settled. */
  current(now: number): LiveFight | null {
    const fight = this.splitter?.peek(Math.max(now, this.lastEventT ?? now));
    if (!fight || !this.playerGuid) return null;
    const analysis = this.analyze(fight);
    this.raise(fight, analysis, fight.endT - 250);
    return liveView(fight, analysis, fight.endT);
  }

  private startSplitter(guid: string) {
    this.splitter = new FightSplitter(guid, { ...this.opts.splitter, keepFinished: false });
    const held = this.buffer;
    this.buffer = [];
    for (const ev of held) this.splitter.push(ev);
    this.collect();
  }

  private collect() {
    if (!this.splitter) return;
    for (const f of this.splitter.drain()) this.finalize(f);
  }

  private analyze(fight: Fight): FightAnalysis {
    const guid = this.playerGuid!;
    return analyzeFightInContext(fight, this.context, {
      playerGuid: guid,
      playerName: this.scanner.player(guid)?.name ?? shortName(guid),
      modelId: this.model?.id ?? null,
      header: this.reader.header,
    });
  }

  private finalize(fight: Fight) {
    const analysis = this.analyze(fight);
    this.raise(fight, analysis, Infinity);
    const callouts = [...(this.emitted.get(fight.startT)?.values() ?? [])];
    this.emitted.delete(fight.startT);
    this.completed.push({ report: analysis.report, callouts });
    this.context.push(fight);
    if (this.context.length > (this.opts.contextFights ?? 12)) this.context.shift();
  }

  private raise(fight: Fight, analysis: FightAnalysis, settledBefore: number) {
    let seen = this.emitted.get(fight.startT);
    if (!seen) {
      seen = new Map();
      this.emitted.set(fight.startT, seen);
    }
    for (const c of calloutsFor(fight, analysis, settledBefore)) {
      if (seen.has(c.id)) continue;
      seen.set(c.id, c);
      this.fresh.push(c);
    }
  }
}

function liveView(fight: Fight, a: FightAnalysis, now: number): LiveFight {
  const { report, state } = a;
  const metric = report.model?.metric ?? "damage";
  const lastGcd = [...a.metrics.casts].reverse().find((c) => c.gcd);
  const gcdFreeAt = lastGcd ? fight.startT + lastGcd.t + a.gcdMs : fight.startT;
  const target = state?.targetAt(now) ?? null;
  // Target auras are clipped to the target's last logged activity, so ask about the latest event, not the clock.
  const asOf = Math.min(now, fight.events.at(-1)?.t ?? now) - 1;
  const groups = new Set(state?.idx.model.auras.map((d) => d.group).filter(Boolean) ?? []);
  const uptimes = report.uptimes
    .filter((u) => u.scored || groups.has(u.key))
    .map((u) => ({
      key: u.key,
      label: u.label,
      pct: u.pct,
      targetPct: u.targetPct,
      active: state ? state.auraActive(u.key, asOf, target) : false,
    }));
  return {
    startT: fight.startT,
    label: fight.label,
    kind: fight.kind,
    targets: fight.targets.slice(0, 5).map((t) => t.name),
    elapsedMs: now - fight.startT,
    score: report.score.overall,
    gcdUsage: report.activity.gcdUsage,
    idleNowMs: Math.max(0, now - gcdFreeAt),
    readyIdleMs: report.activity.readyIdleMs,
    metric,
    perSecond: metric === "threat" ? report.totals.tps : metric === "healing" ? report.totals.hps : report.totals.dps,
    uptimes,
  };
}

/**
 * Rotation callouts for one fight. Only issues that ended before `settledBefore` (log time) are returned,
 * so a gap still in progress is not reported until it closes or the fight ends.
 */
export function calloutsFor(fight: Fight, a: FightAnalysis, settledBefore: number): Callout[] {
  const out: Callout[] = [];
  const start = fight.startT;
  const push = (kind: CalloutKind, at: number, text: string) =>
    out.push({ id: `${kind}:${Math.round(at)}`, kind, fightStartT: start, offsetMs: Math.max(0, at - start), text });
  const { state, report } = a;

  if (state) {
    const { idx } = state;
    // Procs: a window opens on the trigger and closes when the ability is used or the window runs out.
    for (const proc of idx.model.procs) {
      if (!state.facts.known.has(proc.spell)) continue;
      const label = idx.spellByKey.get(proc.spell)?.label ?? proc.label;
      const triggers = state.procTriggers.get(proc.key) ?? [];
      const uses = state.casts.filter((c) => c.key === proc.spell).map((c) => c.t);
      let i = 0;
      while (i < triggers.length) {
        const open = triggers[i]!;
        const used = uses.find((t) => t >= open);
        let last = open;
        let j = i + 1;
        while (j < triggers.length && triggers[j]! < last + proc.windowMs && (used === undefined || triggers[j]! < used)) {
          last = triggers[j]!;
          j++;
        }
        i = j;
        const expiry = last + proc.windowMs;
        const wasUsed = used !== undefined && used < expiry;
        const close = Math.min(wasUsed ? used : expiry, state.end);
        if (close >= settledBefore || (!wasUsed && expiry > state.end && settledBefore !== Infinity)) continue;
        let available = 0;
        for (let t = open; t < close; t += 100) if (state.readyAt(proc.spell, t)) available += 100;
        if (wasUsed && available >= 2000) push("proc", open, `${label} was available for ${s1(available)}`);
        else if (!wasUsed && available >= 1500) push("proc", open, `${label} was available for ${s1(available)} and went unused`);
      }
    }

    // Idle while something in the priority list was ready.
    for (const [a0, b0] of report.activity.idleGaps) {
      if (start + b0 >= settledBefore || b0 - a0 < 2000) continue;
      const at = start + a0;
      const rule = state.expectedAt(at + 400, state.targetAt(at));
      const spell = rule ? idx.spellByKey.get(rule.spell)?.label : null;
      push("idle", at, spell ? `Idle for ${s1(b0 - a0)} while ${spell} was ready` : `Idle for ${s1(b0 - a0)}`);
    }

    // Grouped player auras (seals): time with none of them up, once the player has shown they use one.
    const groups = new Map<string, Interval[]>();
    for (const def of idx.model.auras) {
      if (def.on !== "player" || !def.group) continue;
      const list = groups.get(def.group) ?? [];
      list.push(...(state.tracks.get(`${def.key}|${state.playerGuid}`)?.intervals ?? []));
      groups.set(def.group, list);
    }
    for (const [group, intervals] of groups) {
      const union = mergeIntervals(intervals);
      const usesGroup = union.length > 0 || idx.model.auras.some((d) => d.group === group && state.facts.known.has(d.appliedBy ?? ""));
      if (!usesGroup) continue;
      let cursor = state.start;
      const gaps: Interval[] = [];
      for (const [x, y] of union) {
        if (x - cursor >= 3000) gaps.push([cursor, x]);
        cursor = Math.max(cursor, y);
      }
      if (state.end - cursor >= 3000) gaps.push([cursor, settledBefore === Infinity ? state.end : Infinity]);
      for (const [x, y] of gaps) if (y < settledBefore) push("aura", x, `No ${group} for ${s0(y - x)}`);
    }

    for (const m of report.adherence?.misses ?? []) {
      push("priority", start + m.t, `${m.expected}, but you cast ${m.actual}`);
    }
  } else {
    for (const [a0, b0] of report.activity.idleGaps) {
      if (start + b0 >= settledBefore || b0 - a0 < 2500) continue;
      push("idle", start + a0, `No global cooldown used for ${s1(b0 - a0)}`);
    }
  }

  // Rage at the cap: income is being thrown away.
  const res = report.resource;
  if (res && res.name === "Rage" && res.max > 0) {
    const capped = (v: number) => v >= res.max * 0.98;
    let runStart: number | null = null;
    for (const [t, v] of res.samples) {
      if (capped(v)) runStart ??= t;
      else if (runStart !== null) {
        if (t - runStart >= 1500 && start + t < settledBefore) push("resource", start + runStart, `Rage capped for ${s1(t - runStart)}`);
        runStart = null;
      }
    }
    if (runStart !== null && settledBefore === Infinity) {
      const end = report.fight.durationMs;
      if (end - runStart >= 1500) push("resource", start + runStart, `Rage capped for ${s1(end - runStart)}`);
    }
  }

  return out.sort((x, y) => x.offsetMs - y.offsetMs);
}
