import { isGuidLike, parseFlags } from "./guid";
import type { Field, LogHeader, TokenizedLine } from "./tokenizer";
import type { AdvancedInfo, CombatEvent, LogUnit } from "./types";

/** Suffixes that carry the advanced-logging block (when ADVANCED_LOG_ENABLED is 1). */
const ADVANCED_SUFFIXES = ["_DAMAGE", "_DAMAGE_LANDED", "_HEAL", "_ENERGIZE", "_DRAIN", "_LEECH", "_CAST_SUCCESS"];

const PREFIXES = ["SPELL_PERIODIC", "SPELL_BUILDING", "SPELL", "RANGE", "SWING", "ENVIRONMENTAL", "DAMAGE"] as const;

const str = (f: Field | undefined): string | undefined => (typeof f === "string" && f !== "nil" ? f : undefined);

function num(f: Field | undefined): number | undefined {
  const s = str(f);
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const bool = (f: Field | undefined) => str(f) === "1";

function numList(f: Field | undefined): number[] | undefined {
  const s = str(f);
  if (!s) return undefined;
  const values = s.split("|").map(Number);
  return values.every(Number.isFinite) ? values : undefined;
}

function unit(fields: Field[], at: number): LogUnit | null {
  const guid = str(fields[at]);
  if (!guid || guid === "0000000000000000") return null;
  return { guid, name: str(fields[at + 1]) ?? "Unknown", flags: parseFlags(str(fields[at + 2])) };
}

/**
 * Advanced parameters. Retail (COMBAT_LOG_VERSION 20+) writes 17: infoGUID, ownerGUID, currentHP, maxHP,
 * attackPower, spellPower, armor, absorb, powerType, currentPower, maxPower, powerCost, positionX,
 * positionY, uiMapID, facing, level. Older logs have no absorb field (16).
 */
function advanced(fields: Field[], at: number, version: number | null): { info: AdvancedInfo; length: number } {
  const hasAbsorb = version === null || version >= 20;
  const o = hasAbsorb ? 1 : 0;
  const info: AdvancedInfo = {
    guid: str(fields[at]) ?? "",
    hp: num(fields[at + 2]),
    maxHp: num(fields[at + 3]),
    attackPower: num(fields[at + 4]),
    spellPower: num(fields[at + 5]),
    armor: num(fields[at + 6]),
    powerType: numList(fields[at + 7 + o]),
    power: numList(fields[at + 8 + o]),
    maxPower: numList(fields[at + 9 + o]),
    powerCost: num(fields[at + 10 + o]),
    x: num(fields[at + 11 + o]),
    y: num(fields[at + 12 + o]),
    level: num(fields[at + 15 + o]),
  };
  return { info, length: 16 + o };
}

export interface NormalizeContext {
  header: LogHeader;
}

/** Turn a tokenized line into a CombatEvent. Returns null for lines Vigil does not use. */
export function normalizeEvent(line: TokenizedLine, ctx: NormalizeContext): CombatEvent | null {
  const { event: type, fields, timestamp: t } = line;

  if (type === "ENCOUNTER_START" || type === "ENCOUNTER_END") {
    const id = num(fields[0]) ?? 0;
    const name = str(fields[1]) ?? "Encounter";
    const difficulty = num(fields[2]);
    const ev: CombatEvent = { t, type, src: null, dst: null, encounter: { id, name, difficulty } };
    if (type === "ENCOUNTER_END") {
      ev.encounter!.success = bool(fields[4]);
      ev.encounter!.durationMs = num(fields[5]);
    }
    return ev;
  }

  const prefix = PREFIXES.find((p) => type.startsWith(`${p}_`));
  if (!prefix && type !== "UNIT_DIED" && type !== "PARTY_KILL") return null;

  const ev: CombatEvent = { t, type, src: unit(fields, 0), dst: unit(fields, 4) };
  if (!prefix) return ev;

  let i = 8;
  if (prefix === "SPELL" || prefix === "SPELL_PERIODIC" || prefix === "SPELL_BUILDING" || prefix === "RANGE") {
    ev.spellId = num(fields[i]);
    ev.spellName = str(fields[i + 1]);
    ev.school = parseFlags(str(fields[i + 2]));
    i += 3;
  } else if (prefix === "ENVIRONMENTAL") {
    ev.spellName = str(fields[i]) ?? "Environment";
    i += 1;
  } else if (prefix === "DAMAGE") {
    // DAMAGE_SPLIT / DAMAGE_SHIELD carry a spell prefix as well.
    ev.spellId = num(fields[i]);
    ev.spellName = str(fields[i + 1]);
    ev.school = parseFlags(str(fields[i + 2]));
    i += 3;
  }

  const suffix = type.slice(prefix.length);
  const advancedOff = ctx.header.version !== null && !ctx.header.advanced;
  if (!advancedOff && ADVANCED_SUFFIXES.includes(suffix) && isGuidLike(str(fields[i]))) {
    const adv = advanced(fields, i, ctx.header.version);
    ev.adv = adv.info;
    i += adv.length;
  }

  const rest = fields.slice(i);
  if (suffix === "_DAMAGE" || suffix === "_DAMAGE_LANDED" || suffix === "_SHIELD" || suffix === "_SPLIT") {
    // amount, [baseAmount (retail)], overkill, school, resisted, blocked, absorbed, critical, glancing, crushing, isOffHand
    const b = rest.length >= 11 ? 1 : 0;
    ev.amount = num(rest[0]) ?? 0;
    ev.overkill = Math.max(0, num(rest[1 + b]) ?? 0);
    ev.resisted = num(rest[3 + b]);
    ev.blocked = num(rest[4 + b]);
    ev.absorbed = num(rest[5 + b]);
    ev.critical = bool(rest[6 + b]);
    ev.offHand = bool(rest[9 + b]);
  } else if (suffix === "_MISSED") {
    ev.missType = str(rest[0]);
    ev.offHand = bool(rest[1]);
    ev.amount = num(rest[2]);
  } else if (suffix === "_HEAL") {
    // amount, [baseAmount (retail)], overhealing, absorbed, critical
    const b = rest.length >= 5 ? 1 : 0;
    ev.amount = num(rest[0]) ?? 0;
    ev.overheal = num(rest[1 + b]) ?? 0;
    ev.absorbed = num(rest[2 + b]);
    ev.critical = bool(rest[3 + b]);
  } else if (suffix === "_ENERGIZE") {
    ev.amount = num(rest[0]) ?? 0;
    ev.overEnergize = num(rest[1]) ?? 0;
    ev.powerType = num(rest[2]);
  } else if (suffix.startsWith("_AURA_")) {
    ev.auraType = str(rest[0]);
    if (suffix.endsWith("_DOSE")) ev.stacks = num(rest[1]);
  }
  return ev;
}
