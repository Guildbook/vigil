import { abilityName, effectiveHeal, isDamage, isHeal, isHostileNpc, isMiss } from "@/lib/combatlog/events";
import { FLAGS, isGuidLike, isPlayerGuid, npcIdFromGuid, shortName } from "@/lib/combatlog/guid";
import { normalizeEvent } from "@/lib/combatlog/normalize";
import { parseHeader, tokenizeLine, type LogHeader } from "@/lib/combatlog/tokenizer";
import type { CombatEvent, LogUnit } from "@/lib/combatlog/types";
import type { Faction, WowClass } from "@/lib/game";
import type { Boss } from "../data/bosses";
import { bossForEncounter, bossForUnit, matchAbility, raidById } from "./intel";
import type { SpellIcons } from "./media";

/**
 * The whole group's side of each fight, for the window only (nothing here is uploaded): who dealt and healed
 * what, who died to what, and which hostile abilities hit the group. The Vigil analysis follows the recording
 * player alone; this follows everyone in their party or raid.
 *
 * Fights are split like the analysis splits them: ENCOUNTER_START/END bound boss fights, anything else is a pull
 * that ends after a few seconds without a hostile exchange. Pets are not attributed to their owners (the Classic
 * log does not say whose they are).
 */

/**
 * Reads lines for the observer. Same as the shared LogReader, plus one correction: with advanced logging on,
 * ENVIRONMENTAL_DAMAGE puts the 17-field advanced block before the environment type, which the shared
 * normalizer reads as the type (a GUID). Here the type is taken from after the block.
 */
export class GroupReader {
  private header: LogHeader = { version: null, advanced: false, build: null, projectId: null };

  constructor(private readonly fallbackYear = new Date().getUTCFullYear()) {}

  read(line: string): CombatEvent | null {
    if (!line.trim()) return null;
    const tok = tokenizeLine(line, this.fallbackYear);
    if (!tok) return null;
    if (tok.event === "COMBAT_LOG_VERSION") {
      this.header = parseHeader(tok.fields);
      return null;
    }
    let ev: CombatEvent | null;
    try {
      ev = normalizeEvent(tok, { header: this.header });
    } catch {
      return null;
    }
    if (ev?.type === "ENVIRONMENTAL_DAMAGE" && isGuidLike(ev.spellName)) {
      const hasAbsorb = this.header.version === null || this.header.version >= 20;
      const type = tok.fields[8 + (hasAbsorb ? 17 : 16)];
      ev.spellName = typeof type === "string" && !isGuidLike(type) ? type : "Environment";
    }
    return ev;
  }
}

/** COMBATLOG_OBJECT_AFFILIATION_MINE | PARTY | RAID. */
const GROUP_MASK = 0x7;
const TRASH_GAP_MS = 8000;
const BOSS_GAP_MS = 60_000;
const KEEP_FINISHED = 30;

export interface GroupSpellView {
  spellId: number | null;
  name: string;
  damage: number;
  healing: number;
}

export interface GroupPlayerView {
  guid: string;
  name: string;
  wowClass: WowClass | null;
  isMe: boolean;
  damage: number;
  healing: number;
  dps: number;
  hps: number;
  deaths: number;
  /** Top abilities by damage plus healing (the recording player only, to keep state small). */
  spells: GroupSpellView[];
}

export interface GroupAbilityView {
  spellId: number | null;
  name: string;
  source: string;
  damage: number;
  hits: number;
  /** Debuff applications on the group. */
  debuffs: number;
  /** Players it hit or debuffed. */
  players: number;
  topTargets: { name: string; wowClass: WowClass | null; amount: number }[];
  kills: number;
  /** The matching entry in the boss intel, if the fight is a known boss and the ability is listed. */
  intelKey: string | null;
}

export interface GroupDeathView {
  offsetMs: number;
  name: string;
  wowClass: WowClass | null;
  isMe: boolean;
  /** The last hit before death, if one was logged in the 10 seconds before. */
  blow: { spellId: number | null; name: string; amount: number; source: string } | null;
}

export interface GroupFightView {
  id: string;
  startT: number;
  durationMs: number;
  live: boolean;
  label: string;
  kind: "boss" | "trash";
  encounter: { id: number; name: string; success?: boolean } | null;
  boss: { key: string; name: string; raid: string; displayId: number | null; status: Boss["status"] } | null;
  faction: Faction | null;
  players: GroupPlayerView[];
  abilities: GroupAbilityView[];
  deaths: GroupDeathView[];
}

interface Hit {
  t: number;
  spellId: number | null;
  name: string;
  amount: number;
  source: string;
}

interface PlayerAgg {
  guid: string;
  name: string;
  damage: number;
  healing: number;
  deaths: number;
  spells: Map<string, GroupSpellView>;
}

interface AbilityAgg {
  spellId: number | null;
  name: string;
  source: string;
  damage: number;
  hits: number;
  debuffs: number;
  targets: Map<string, number>;
  kills: number;
}

interface Segment {
  startT: number;
  lastT: number;
  endT: number | null;
  kind: "boss" | "trash";
  encounter: GroupFightView["encounter"];
  boss: Boss | null;
  players: Map<string, PlayerAgg>;
  abilities: Map<string, AbilityAgg>;
  deaths: { t: number; guid: string; name: string; blow: Hit | null }[];
  /** Damage the group dealt to each hostile unit name, for the label of a pull. */
  enemies: Map<string, number>;
  groupDamage: number;
}

export interface GroupObserverOptions {
  icons: SpellIcons;
  /** The player's class when the site knows the character. */
  classFor?: (name: string) => WowClass | null | undefined;
  onFinished?: (fight: GroupFightView) => void;
}

const isGroupPlayer = (u: LogUnit | null): u is LogUnit => Boolean(u && isPlayerGuid(u.guid) && u.flags & FLAGS.typePlayer && u.flags & GROUP_MASK);

export class GroupObserver {
  private open: Segment | null = null;
  private readonly finished: GroupFightView[] = [];
  private readonly classVotes = new Map<string, Map<WowClass, number>>();
  private readonly names = new Map<string, string>();
  private readonly lastHit = new Map<string, Hit>();
  private me: string | null = null;

  constructor(private readonly opts: GroupObserverOptions) {}

  reset() {
    this.close();
    this.classVotes.clear();
    this.lastHit.clear();
    this.me = null;
  }

  /** Closes the open fight if it has been quiet long enough by log time `now`. */
  tick(now: number) {
    const s = this.open;
    if (s && now - s.lastT > (s.kind === "boss" ? BOSS_GAP_MS : TRASH_GAP_MS)) this.close();
  }

  push(ev: CombatEvent) {
    this.tick(ev.t);
    const { src, dst } = ev;
    if (src && isPlayerGuid(src.guid)) {
      if (src.flags & FLAGS.affiliationMine) this.me = src.guid;
      this.names.set(src.guid, shortName(src.name));
      if (ev.spellId && (ev.type === "SPELL_CAST_SUCCESS" || ev.type === "SPELL_AURA_APPLIED")) this.vote(src.guid, ev.spellId);
    }

    if (ev.type === "ENCOUNTER_START" && ev.encounter) {
      this.close();
      this.open = this.start(ev.t, "boss");
      this.open.encounter = { id: ev.encounter.id, name: ev.encounter.name };
      this.open.boss = bossForEncounter(ev.encounter.id);
      return;
    }
    if (ev.type === "ENCOUNTER_END") {
      if (this.open?.kind === "boss") {
        this.open.encounter!.success = ev.encounter?.success;
        this.open.lastT = Math.max(this.open.lastT, ev.t);
        this.close(ev.t);
      }
      return;
    }

    const hostileExchange =
      (isDamage(ev) || isMiss(ev)) && ((isGroupPlayer(src) && isHostileNpc(dst)) || (isHostileNpc(src) && isGroupPlayer(dst)));
    if (!this.open) {
      if (!hostileExchange) return;
      this.open = this.start(ev.t, "trash");
    }
    const s = this.open;
    if (hostileExchange) s.lastT = ev.t;

    for (const unit of [src, dst]) {
      if (!s.boss && unit && isHostileNpc(unit)) s.boss = bossForUnit(npcIdFromGuid(unit.guid), shortName(unit.name));
    }

    if (isDamage(ev)) this.damage(s, ev);
    else if (ev.type === "ENVIRONMENTAL_DAMAGE" && isGroupPlayer(dst)) this.hitPlayer(s, ev, dst, "Environment");
    else if (isHeal(ev) && isGroupPlayer(src)) {
      const amount = effectiveHeal(ev);
      const p = this.player(s, src);
      p.healing += amount;
      this.spell(p, ev).healing += amount;
    } else if (ev.type === "SPELL_AURA_APPLIED" && ev.auraType === "DEBUFF" && isHostileNpc(src) && isGroupPlayer(dst)) {
      const a = this.ability(s, ev, shortName(src!.name));
      a.debuffs++;
      a.targets.set(dst.guid, a.targets.get(dst.guid) ?? 0);
    } else if (ev.type === "UNIT_DIED" && isGroupPlayer(dst)) {
      const hit = this.lastHit.get(dst.guid);
      const blow = hit && ev.t - hit.t <= 10_000 ? hit : null;
      s.deaths.push({ t: ev.t, guid: dst.guid, name: shortName(dst.name), blow });
      this.player(s, dst).deaths++;
      if (blow) {
        const a = s.abilities.get(abilityKey(blow.spellId, blow.name, blow.source));
        if (a) a.kills++;
      }
      this.lastHit.delete(dst.guid);
    }
  }

  private damage(s: Segment, ev: CombatEvent) {
    const { src, dst } = ev;
    const amount = ev.amount ?? 0;
    if (isGroupPlayer(src) && isHostileNpc(dst)) {
      const p = this.player(s, src);
      p.damage += amount;
      this.spell(p, ev).damage += amount;
      s.groupDamage += amount;
      const enemy = shortName(dst!.name);
      s.enemies.set(enemy, (s.enemies.get(enemy) ?? 0) + amount);
    } else if (isHostileNpc(src) && isGroupPlayer(dst)) {
      this.hitPlayer(s, ev, dst, shortName(src!.name));
    }
  }

  private hitPlayer(s: Segment, ev: CombatEvent, dst: LogUnit, source: string) {
    const amount = ev.amount ?? 0;
    const a = this.ability(s, ev, source);
    a.damage += amount;
    a.hits++;
    a.targets.set(dst.guid, (a.targets.get(dst.guid) ?? 0) + amount);
    this.player(s, dst);
    this.lastHit.set(dst.guid, { t: ev.t, spellId: a.spellId, name: a.name, amount, source });
  }

  private vote(guid: string, spellId: number) {
    const cls = this.opts.icons.classOf(spellId);
    if (!cls) return;
    let votes = this.classVotes.get(guid);
    if (!votes) this.classVotes.set(guid, (votes = new Map()));
    votes.set(cls, (votes.get(cls) ?? 0) + 1);
  }

  /** The class the site knows for this character, else the class whose spells they cast most. */
  classOf(guid: string): WowClass | null {
    const name = this.names.get(guid);
    const known = name ? this.opts.classFor?.(name) : null;
    if (known) return known;
    let best: WowClass | null = null;
    let most = 0;
    for (const [cls, n] of this.classVotes.get(guid) ?? []) {
      if (n > most) [best, most] = [cls, n];
    }
    return best;
  }

  private start(t: number, kind: Segment["kind"]): Segment {
    return {
      startT: t,
      lastT: t,
      endT: null,
      kind,
      encounter: null,
      boss: null,
      players: new Map(),
      abilities: new Map(),
      deaths: [],
      enemies: new Map(),
      groupDamage: 0,
    };
  }

  private player(s: Segment, unit: LogUnit): PlayerAgg {
    let p = s.players.get(unit.guid);
    if (!p) {
      p = { guid: unit.guid, name: shortName(unit.name), damage: 0, healing: 0, deaths: 0, spells: new Map() };
      s.players.set(unit.guid, p);
    }
    return p;
  }

  private spell(p: PlayerAgg, ev: CombatEvent): GroupSpellView {
    const name = abilityName(ev);
    const key = `${ev.spellId ?? 0}|${name}`;
    let sp = p.spells.get(key);
    if (!sp) p.spells.set(key, (sp = { spellId: ev.spellId ?? null, name, damage: 0, healing: 0 }));
    return sp;
  }

  private ability(s: Segment, ev: CombatEvent, source: string): AbilityAgg {
    const spellId = ev.type.startsWith("SWING_") || ev.type === "ENVIRONMENTAL_DAMAGE" ? null : (ev.spellId ?? null);
    const name = abilityName(ev);
    const key = abilityKey(spellId, name, source);
    let a = s.abilities.get(key);
    if (!a) s.abilities.set(key, (a = { spellId, name, source, damage: 0, hits: 0, debuffs: 0, targets: new Map(), kills: 0 }));
    return a;
  }

  private close(endT?: number) {
    const s = this.open;
    this.open = null;
    if (!s) return;
    s.endT = endT ?? s.lastT;
    if (s.kind === "trash" && (s.endT - s.startT < 2000 || s.groupDamage === 0)) return;
    const view = this.view(s, false);
    this.finished.unshift(view);
    this.finished.length = Math.min(this.finished.length, KEEP_FINISHED);
    this.opts.onFinished?.(view);
  }

  /** The fight in progress as of log time `now`, or null between pulls. */
  current(now: number): GroupFightView | null {
    return this.open ? this.view(this.open, true, now) : null;
  }

  recent(): GroupFightView[] {
    return this.finished;
  }

  private view(s: Segment, live: boolean, now?: number): GroupFightView {
    const end = live ? Math.max(s.lastT, now ?? s.lastT) : s.endT!;
    const durationMs = Math.max(1, end - s.startT);
    const secs = durationMs / 1000;
    const classOf = (guid: string) => this.classOf(guid);
    const players = [...s.players.values()]
      .map((p) => ({
        guid: p.guid,
        name: p.name,
        wowClass: classOf(p.guid),
        isMe: p.guid === this.me,
        damage: p.damage,
        healing: p.healing,
        dps: p.damage / secs,
        hps: p.healing / secs,
        deaths: p.deaths,
        spells:
          p.guid === this.me
            ? [...p.spells.values()].sort((a, b) => b.damage + b.healing - (a.damage + a.healing)).slice(0, 8)
            : [],
      }))
      .sort((a, b) => b.damage - a.damage || b.healing - a.healing);
    const boss = s.boss;
    const abilities = [...s.abilities.values()]
      .map((a) => ({
        spellId: a.spellId,
        name: a.name,
        source: a.source,
        damage: a.damage,
        hits: a.hits,
        debuffs: a.debuffs,
        players: a.targets.size,
        topTargets: [...a.targets.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 3)
          .map(([guid, amount]) => ({ name: this.names.get(guid) ?? s.players.get(guid)?.name ?? "Unknown", wowClass: classOf(guid), amount })),
        kills: a.kills,
        intelKey: boss ? (matchAbility(boss, a.spellId, a.name)?.key ?? null) : null,
      }))
      .sort((a, b) => b.damage - a.damage || b.debuffs - a.debuffs)
      .slice(0, 24);
    const topEnemy = [...s.enemies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const classes = players.map((p) => p.wowClass);
    return {
      id: String(s.startT),
      startT: s.startT,
      durationMs,
      live,
      label: s.encounter?.name ?? boss?.name ?? (topEnemy ? `${topEnemy}${s.enemies.size > 1 ? ` +${s.enemies.size - 1}` : ""}` : "Unknown"),
      kind: s.kind,
      encounter: s.encounter ? { ...s.encounter } : null,
      boss: boss ? { key: boss.key, name: boss.name, raid: raidById(boss.raid).name, displayId: boss.displayId, status: boss.status } : null,
      faction: factionFromClasses(classes),
      players,
      abilities,
      deaths: s.deaths.map((d) => ({
        offsetMs: d.t - s.startT,
        name: d.name,
        wowClass: classOf(d.guid),
        isMe: d.guid === this.me,
        blow: d.blow ? { spellId: d.blow.spellId, name: d.blow.name, amount: d.blow.amount, source: d.blow.source } : null,
      })),
    };
  }
}

function abilityKey(spellId: number | null, name: string, source: string) {
  return `${spellId ?? 0}|${name}|${source}`;
}

/** In Classic Era only the Alliance has Paladins and only the Horde has Shamans. */
export function factionFromClasses(classes: (WowClass | null)[]): Faction | null {
  if (classes.includes("paladin")) return "alliance";
  if (classes.includes("shaman")) return "horde";
  return null;
}
