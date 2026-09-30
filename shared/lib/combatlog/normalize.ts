import { isGuidLike, isPlayerGuid, parseFlags } from "./guid";
import type { Field, LogHeader, TokenizedLine } from "./tokenizer";
import type { AdvancedInfo, CombatEvent, LogUnit } from "./types";

/** Suffixes that carry the advanced-logging block (when ADVANCED_LOG_ENABLED is 1). */
const ADVANCED_SUFFIXES = [
  "_DAMAGE",
  "_DAMAGE_LANDED",
  "_SHIELD",
  "_SPLIT",
  "_HEAL",
  "_ENERGIZE",
  "_DRAIN",
  "_LEECH",
  "_CAST_SUCCESS",
];

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
  const values = s.split(/[|:]/).map(Number);
  return values.every(Number.isFinite) ? values : undefined;
}

const INT = /^-?\d+$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const INT_LIST = /^-?\d+([|:]-?\d+)*$/;
const is = (re: RegExp, f: Field | undefined) => typeof f === "string" && re.test(f);

function unit(fields: Field[], at: number): LogUnit | null {
  const guid = str(fields[at]);
  if (!guid || guid === "0000000000000000") return null;
  return { guid, name: str(fields[at + 1]) ?? "Unknown", flags: parseFlags(str(fields[at + 2])) };
}

/**
 * Whether the advanced block at `at` has `extra` fields between armor and powerType: infoGUID, ownerGUID,
 * currentHP, maxHP, attackPower, spellPower, armor, [extra], powerType, currentPower, maxPower, powerCost,
 * positionX, positionY, uiMapID, facing, level.
 */
function fitsLayout(fields: Field[], at: number, extra: number): boolean {
  const p = at + 7 + extra;
  const power = [fields[p], fields[p + 1], fields[p + 2]].map((f) => (typeof f === "string" ? f.split(/[|:]/).length : -1));
  const facing = num(fields[p + 7]);
  return (
    isGuidLike(str(fields[at + 1])) &&
    [2, 3, 4, 5, 6].every((k) => is(INT, fields[at + k])) &&
    [p, p + 1, p + 2].every((k) => is(INT_LIST, fields[k])) &&
    power[0] === power[1] &&
    power[1] === power[2] &&
    is(INT, fields[p + 3]) &&
    is(NUMBER, fields[p + 4]) &&
    is(NUMBER, fields[p + 5]) &&
    is(INT, fields[p + 6]) &&
    is(NUMBER, fields[p + 7]) &&
    facing !== undefined &&
    Math.abs(facing) <= 7 &&
    is(INT, fields[p + 8])
  );
}

/** Level cap of the client that wrote the log, from BUILD_VERSION (Classic branches), else the schema's 100. */
function maxLevel(build: string | null): number {
  const major = Number(build?.split(".")[0]);
  return ({ 1: 60, 2: 70, 3: 80, 4: 85, 5: 90 } as Record<number, number>)[major] ?? 100;
}

/** WoW: Forever (project 18, 1.60+ builds) writes item level in the level column for players, under the cap too. */
const writesItemLevel = (header: LogHeader) => header.projectId === 18 || /^1\.([6-9]\d|\d{3,})\./.test(header.build ?? "");

/**
 * Advanced parameters: 16 fields plus 0 to 4 between armor and powerType. Retail (COMBAT_LOG_VERSION 20+)
 * writes absorb there (17); older retail writes nothing (16); the TBC Anniversary client (version 9, build
 * 2.5.x) writes two (18). The layout is read from the fields, falling back to the version when none fits.
 */
function advanced(fields: Field[], at: number, header: LogHeader): { info: AdvancedInfo; length: number } {
  const byVersion = header.version === null || header.version >= 20 ? 1 : 0;
  const o = [byVersion, 0, 1, 2, 3, 4].find((extra) => fitsLayout(fields, at, extra)) ?? byVersion;
  const guid = str(fields[at]) ?? "";
  // Modern clients write item level in the level column for players; a value over the cap is not a level.
  const level = num(fields[at + 15 + o]);
  const playerLevelOk =
    level !== undefined && level >= 1 && level <= maxLevel(header.build) && !writesItemLevel(header);
  const info: AdvancedInfo = {
    guid,
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
    level: !isPlayerGuid(guid) || playerLevelOk ? level : undefined,
  };
  return { info, length: 16 + o };
}

const isOverkill = (f: Field | undefined) => is(INT, f) && Number(f) >= -1;
const isSchool = (f: Field | undefined) => is(INT, f) && Number(f) >= 1 && Number(f) <= 127;

/**
 * Whether a damage suffix carries baseAmount after amount (retail, and Classic clients built on it). Read from
 * the overkill and school fields, since 2.5.x swings write baseAmount in 10 fields; the length decides a tie.
 */
function hasBaseAmount(rest: Field[]): boolean {
  const withBase = isOverkill(rest[2]) && isSchool(rest[3]);
  const without = isOverkill(rest[1]) && isSchool(rest[2]);
  if (withBase !== without) return withBase;
  return rest.length >= 11;
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

  const suffix = type.slice(prefix.length);
  let i = 8;
  const readAdvanced = () => {
    if (!ADVANCED_SUFFIXES.includes(suffix) || !isGuidLike(str(fields[i]))) return;
    // WoW: Forever writes the block while its header says ADVANCED_LOG_ENABLED,0; a block that fits is trusted,
    // and the header is corrected so reports do not claim advanced logging was off.
    const headerSaysOff = ctx.header.version !== null && !ctx.header.advanced;
    if (headerSaysOff && ![0, 1, 2, 3, 4].some((extra) => fitsLayout(fields, i, extra))) return;
    if (headerSaysOff) ctx.header.advanced = true;
    const adv = advanced(fields, i, ctx.header);
    ev.adv = adv.info;
    i += adv.length;
  };

  if (prefix === "SPELL" || prefix === "SPELL_PERIODIC" || prefix === "SPELL_BUILDING" || prefix === "RANGE") {
    ev.spellId = num(fields[i]);
    ev.spellName = str(fields[i + 1]);
    ev.school = parseFlags(str(fields[i + 2]));
    i += 3;
  } else if (prefix === "ENVIRONMENTAL") {
    // The advanced block comes before the environment type here.
    readAdvanced();
    ev.spellName = str(fields[i]) ?? "Environment";
    i += 1;
  } else if (prefix === "DAMAGE") {
    // DAMAGE_SPLIT / DAMAGE_SHIELD carry a spell prefix as well.
    ev.spellId = num(fields[i]);
    ev.spellName = str(fields[i + 1]);
    ev.school = parseFlags(str(fields[i + 2]));
    i += 3;
  }

  if (prefix !== "ENVIRONMENTAL") readAdvanced();

  const rest = fields.slice(i);
  if (suffix === "_DAMAGE" || suffix === "_DAMAGE_LANDED" || suffix === "_SHIELD" || suffix === "_SPLIT") {
    // amount, [baseAmount (retail)], overkill, school, resisted, blocked, absorbed, critical, glancing, crushing, isOffHand
    const b = hasBaseAmount(rest) ? 1 : 0;
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
