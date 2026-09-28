import { isHostileNpc, isAura, isDamage, isMiss, isHeal } from "./events";
import { npcIdFromGuid, shortName } from "./guid";
import type { CombatEvent } from "./types";

export interface FightTarget {
  guid: string;
  name: string;
  npcId: number | null;
  firstT: number;
  lastT: number;
  /** Damage the player dealt to this unit. */
  damageTaken: number;
  /** Damage this unit dealt to the player. */
  damageDealt: number;
  died: boolean;
}

export interface Fight {
  index: number;
  kind: "boss" | "trash";
  startT: number;
  endT: number;
  label: string;
  encounter?: { id: number; name: string; difficulty?: number; success?: boolean };
  targets: FightTarget[];
  /** Events involving the player, plus auras and deaths on the fight's targets. */
  events: CombatEvent[];
  /** Auras active on the player when the fight began (lowercased name to the time they were applied). */
  initialAuras: Record<string, number>;
}

export interface SplitterOptions {
  /** Trash fights end after this long with no combat involving the player. */
  idleGapMs?: number;
  /** Boss fights missing ENCOUNTER_END end after this long with no combat. */
  bossTimeoutMs?: number;
  /** Fights shorter than this, or where the player did nothing, are dropped. */
  minDurationMs?: number;
  /**
   * Keep every finished fight for `finish()`. Live tailing turns this off and takes fights with `drain()`,
   * so an evening of pulls does not pile up in memory.
   */
  keepFinished?: boolean;
}

interface OpenFight {
  kind: "boss" | "trash";
  startT: number;
  lastActivityT: number;
  encounter?: Fight["encounter"];
  targets: Map<string, FightTarget>;
  events: CombatEvent[];
  initialAuras: Record<string, number>;
  playerActions: number;
}

/**
 * Splits a player's events into fights. ENCOUNTER_START/END bound boss fights; everything else is
 * trash, which starts at the first hostile exchange and ends after `idleGapMs` of quiet.
 */
export class FightSplitter {
  private open: OpenFight | null = null;
  private readonly done: Fight[] = [];
  private pending: Fight[] = [];
  private readonly auras = new Map<string, number>();
  private index = 0;
  private readonly idleGapMs: number;
  private readonly bossTimeoutMs: number;
  private readonly minDurationMs: number;
  private readonly keepFinished: boolean;

  constructor(
    readonly playerGuid: string,
    opts: SplitterOptions = {},
  ) {
    this.idleGapMs = opts.idleGapMs ?? 6000;
    this.bossTimeoutMs = opts.bossTimeoutMs ?? 60_000;
    this.minDurationMs = opts.minDurationMs ?? 2000;
    this.keepFinished = opts.keepFinished ?? true;
  }

  /** Closes the open fight if nothing has happened for its timeout by log time `t`. Returns whether it closed. */
  tick(t: number): boolean {
    if (!this.open) return false;
    const quiet = t - this.open.lastActivityT;
    if (quiet <= (this.open.kind === "boss" ? this.bossTimeoutMs : this.idleGapMs)) return false;
    this.close();
    return true;
  }

  /** Fights finished since the last call. */
  drain(): Fight[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** The fight in progress as if it ended at `t` (default: its last activity), or null between pulls. */
  peek(t?: number): Fight | null {
    const f = this.open;
    if (!f) return null;
    const end = Math.max(f.startT + 1, t ?? f.lastActivityT);
    const targets = sortTargets(f.targets);
    return {
      index: this.index,
      kind: f.kind,
      startT: f.startT,
      endT: end,
      label: f.encounter?.name ?? fightLabel(targets),
      encounter: f.encounter ? { ...f.encounter } : undefined,
      targets: targets.map((x) => ({ ...x })),
      events: f.events.filter((e) => e.t <= end + 1),
      initialAuras: f.initialAuras,
    };
  }

  push(ev: CombatEvent) {
    const me = this.playerGuid;
    const fromMe = ev.src?.guid === me;
    const toMe = ev.dst?.guid === me;

    this.tick(ev.t);

    if (ev.type === "ENCOUNTER_START") {
      this.close();
      this.open = this.start("boss", ev.t);
      this.open.encounter = { ...ev.encounter! };
      return;
    }
    if (ev.type === "ENCOUNTER_END") {
      if (this.open?.kind === "boss") {
        this.open.encounter!.success = ev.encounter?.success;
        this.open.lastActivityT = Math.max(this.open.lastActivityT, ev.t);
        this.close(ev.t);
      }
      return;
    }

    if (toMe && isAura(ev) && ev.spellName) {
      const key = ev.spellName.toLowerCase();
      if (ev.type === "SPELL_AURA_APPLIED") this.auras.set(key, ev.t);
      else if (ev.type === "SPELL_AURA_REMOVED") this.auras.delete(key);
      else if (!this.auras.has(key) && ev.type === "SPELL_AURA_REFRESH") this.auras.set(key, ev.t);
    }

    const hostileExchange =
      (fromMe && (isDamage(ev) || isMiss(ev)) && isHostileNpc(ev.dst)) ||
      (toMe && (isDamage(ev) || isMiss(ev)) && isHostileNpc(ev.src)) ||
      (fromMe && ev.type === "SPELL_CAST_SUCCESS" && isHostileNpc(ev.dst));

    if (!this.open) {
      if (!hostileExchange) return;
      this.open = this.start("trash", ev.t);
    }
    const fight = this.open;

    const target = this.trackTarget(fight, ev, fromMe, toMe);
    const onTarget = Boolean(ev.dst && fight.targets.has(ev.dst.guid));
    if (fromMe || toMe || (onTarget && (isAura(ev) || ev.type === "UNIT_DIED"))) {
      fight.events.push(ev);
    }
    if (hostileExchange) fight.lastActivityT = ev.t;
    if (fromMe && (hostileExchange || isHeal(ev) || ev.type === "SPELL_CAST_SUCCESS")) fight.playerActions++;
    if (target && ev.type === "UNIT_DIED") target.died = true;
  }

  /** Closes the open fight and returns every finished fight (or, with `keepFinished: false`, the undrained ones). */
  finish(): Fight[] {
    this.close();
    return this.keepFinished ? this.done : this.drain();
  }

  private start(kind: OpenFight["kind"], t: number): OpenFight {
    return {
      kind,
      startT: t,
      lastActivityT: t,
      targets: new Map(),
      events: [],
      initialAuras: Object.fromEntries(this.auras),
      playerActions: 0,
    };
  }

  private trackTarget(fight: OpenFight, ev: CombatEvent, fromMe: boolean, toMe: boolean): FightTarget | undefined {
    const other = fromMe ? ev.dst : toMe ? ev.src : ev.type === "UNIT_DIED" ? ev.dst : null;
    if (!other || !isHostileNpc(other)) return undefined;
    let target = fight.targets.get(other.guid);
    if (!target) {
      if (ev.type === "UNIT_DIED") return undefined;
      target = {
        guid: other.guid,
        name: shortName(other.name),
        npcId: npcIdFromGuid(other.guid),
        firstT: ev.t,
        lastT: ev.t,
        damageTaken: 0,
        damageDealt: 0,
        died: false,
      };
      fight.targets.set(other.guid, target);
    }
    target.lastT = ev.t;
    if (isDamage(ev)) {
      if (fromMe) target.damageTaken += ev.amount ?? 0;
      else if (toMe) target.damageDealt += ev.amount ?? 0;
    }
    return target;
  }

  private close(endT?: number) {
    const f = this.open;
    this.open = null;
    if (!f) return;
    const end = endT ?? f.lastActivityT;
    if (f.kind === "trash" && (end - f.startT < this.minDurationMs || f.playerActions === 0)) return;
    const targets = sortTargets(f.targets);
    const fight: Fight = {
      index: this.index++,
      kind: f.kind,
      startT: f.startT,
      endT: end,
      label: f.encounter?.name ?? fightLabel(targets),
      encounter: f.encounter,
      targets,
      events: f.events.filter((e) => e.t <= end + 1),
      initialAuras: f.initialAuras,
    };
    if (this.keepFinished) this.done.push(fight);
    this.pending.push(fight);
  }
}

function sortTargets(targets: Map<string, FightTarget>): FightTarget[] {
  return [...targets.values()].sort((a, b) => b.damageTaken + b.damageDealt - (a.damageTaken + a.damageDealt));
}

/** "Kobold Vermin", or "Kobold Vermin +2" when more mobs were involved. */
export function fightLabel(targets: FightTarget[]): string {
  if (targets.length === 0) return "Unknown";
  const main = targets[0]!.name;
  return targets.length > 1 ? `${main} +${targets.length - 1}` : main;
}