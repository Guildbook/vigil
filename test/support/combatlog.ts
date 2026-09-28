/**
 * Builds synthetic WoWCombatLog.txt text in the retail Advanced Combat Logging layout
 * (COMBAT_LOG_VERSION 22): timestamps with year and UTC offset, 8-field unit prefix, 17-field advanced block.
 */

export interface Unit {
  guid: string;
  name: string;
  flags: string;
}

export interface Power {
  type: number;
  current: number;
  max: number;
  cost?: number;
}

const EMPTY = "0000000000000000";

export function playerUnit(name: string, id = "0A1B2C3D"): Unit {
  return { guid: `Player-4395-${id}`, name: `${name}-Forever-US`, flags: "0x511" };
}

export function mobUnit(name: string, npcId: number, spawn: number): Unit {
  return { guid: `Creature-0-4395-0-12-${npcId}-${spawn.toString(16).padStart(10, "0").toUpperCase()}`, name, flags: "0xa48" };
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export class LogBuilder {
  private readonly entries: { ms: number; line: string }[] = [];
  private readonly base: number;
  private readonly tzHours: number;
  private readonly version: number;
  private readonly advanced: boolean;
  level = 30;

  constructor(opts: { start?: Date; tzHours?: number; version?: number; advanced?: boolean; header?: boolean; build?: string } = {}) {
    this.base = (opts.start ?? new Date(Date.UTC(2026, 8, 27, 1, 0, 0))).getTime();
    this.tzHours = opts.tzHours ?? -4;
    this.version = opts.version ?? 22;
    this.advanced = opts.advanced ?? true;
    if (opts.header !== false) {
      const body = `COMBAT_LOG_VERSION,${this.version},ADVANCED_LOG_ENABLED,${this.advanced ? 1 : 0},BUILD_VERSION,${opts.build ?? "12.1.5"},PROJECT_ID,1`;
      this.entries.push({ ms: -Infinity, line: `${this.stamp(-60_000)}  ${body}` });
    }
  }

  stamp(ms: number): string {
    const local = new Date(this.base + ms + this.tzHours * 3_600_000);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const tz = this.tzHours === 0 ? "+0" : this.tzHours > 0 ? `+${this.tzHours}` : String(this.tzHours);
    return `${local.getUTCMonth() + 1}/${local.getUTCDate()}/${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(
      local.getUTCMinutes(),
    )}:${pad(local.getUTCSeconds())}.${pad(local.getUTCMilliseconds(), 3)}${tz}`;
  }

  raw(ms: number, body: string) {
    this.entries.push({ ms, line: `${this.stamp(ms)}  ${body}` });
    return this;
  }

  private units(src: Unit | null, dst: Unit | null) {
    const u = (x: Unit | null) => (x ? `${x.guid},${q(x.name)},${x.flags},0x0` : `${EMPTY},nil,0x80000000,0x80000000`);
    return `${u(src)},${u(dst)}`;
  }

  private readonly lastPower = new Map<string, Power>();

  /** Units keep their last known power when an event does not give one, as the client reports it. */
  private adv(info: Unit, power: Power | undefined) {
    if (!this.advanced) return null;
    const p = power ?? { ...(this.lastPower.get(info.guid) ?? { type: 0, current: 0, max: 0 }), cost: 0 };
    this.lastPower.set(info.guid, p);
    const absorb = this.version >= 20 ? [0] : [];
    return [info.guid, EMPTY, 1000, 1000, 400, 0, 1200, ...absorb, p.type, p.current, p.max, p.cost ?? 0, "-8913.23", "-120.52", 1429, "1.2", this.level].join(",");
  }

  private spell(id: number, name: string, school = "0x1") {
    return `${id},${q(name)},${school}`;
  }

  cast(ms: number, src: Unit, dst: Unit | null, id: number, name: string, power?: Power) {
    const adv = this.adv(src, power);
    return this.raw(ms, `SPELL_CAST_SUCCESS,${this.units(src, dst)},${this.spell(id, name)}${adv ? `,${adv}` : ""}`);
  }

  castStart(ms: number, src: Unit, id: number, name: string) {
    return this.raw(ms, `SPELL_CAST_START,${this.units(src, null)},${this.spell(id, name)}`);
  }

  private damageSuffix(amount: number, o: { crit?: boolean; blocked?: number; offHand?: boolean }) {
    const base = this.version >= 20 ? [amount, amount] : [amount];
    return [...base, -1, 1, 0, o.blocked ?? 0, 0, o.crit ? 1 : "nil", "nil", "nil", o.offHand ? 1 : "nil"].join(",");
  }

  swing(ms: number, src: Unit, dst: Unit, amount: number, o: { crit?: boolean; blocked?: number; offHand?: boolean; power?: Power } = {}) {
    const adv = this.adv(src, o.power);
    return this.raw(ms, `SWING_DAMAGE,${this.units(src, dst)}${adv ? `,${adv}` : ""},${this.damageSuffix(amount, o)}`);
  }

  swingMiss(ms: number, src: Unit, dst: Unit, missType: string) {
    return this.raw(ms, `SWING_MISSED,${this.units(src, dst)},${missType},nil`);
  }

  damage(
    ms: number,
    src: Unit,
    dst: Unit,
    id: number,
    name: string,
    amount: number,
    o: { crit?: boolean; school?: string; power?: Power; periodic?: boolean } = {},
  ) {
    const adv = this.adv(src, o.power);
    const type = o.periodic ? "SPELL_PERIODIC_DAMAGE" : "SPELL_DAMAGE";
    return this.raw(
      ms,
      `${type},${this.units(src, dst)},${this.spell(id, name, o.school)}${adv ? `,${adv}` : ""},${this.damageSuffix(amount, o)}`,
    );
  }

  miss(ms: number, src: Unit, dst: Unit, id: number, name: string, missType: string) {
    return this.raw(ms, `SPELL_MISSED,${this.units(src, dst)},${this.spell(id, name)},${missType},nil`);
  }

  heal(ms: number, src: Unit, dst: Unit, id: number, name: string, amount: number, overheal = 0) {
    const adv = this.adv(src, undefined);
    const suffix = this.version >= 20 ? [amount, amount, overheal, 0, "nil"] : [amount, overheal, 0, "nil"];
    return this.raw(ms, `SPELL_HEAL,${this.units(src, dst)},${this.spell(id, name, "0x2")}${adv ? `,${adv}` : ""},${suffix.join(",")}`);
  }

  energize(ms: number, src: Unit, id: number, name: string, amount: number, powerType: number, power?: Power) {
    const adv = this.adv(src, power);
    return this.raw(ms, `SPELL_ENERGIZE,${this.units(src, src)},${this.spell(id, name)}${adv ? `,${adv}` : ""},${amount},0,${powerType},100`);
  }

  aura(
    ms: number,
    type: "APPLIED" | "REMOVED" | "REFRESH" | "APPLIED_DOSE" | "REMOVED_DOSE",
    src: Unit,
    dst: Unit,
    id: number,
    name: string,
    auraType: "BUFF" | "DEBUFF" = "BUFF",
    stacks?: number,
  ) {
    const extra = type.endsWith("DOSE") ? `,${stacks ?? 1}` : "";
    return this.raw(ms, `SPELL_AURA_${type},${this.units(src, dst)},${this.spell(id, name)},${auraType}${extra}`);
  }

  /** Retail layout: the advanced block (for the victim) comes before the environment type. */
  environmental(ms: number, dst: Unit, kind: string, amount: number) {
    const adv = this.adv(dst, undefined);
    return this.raw(ms, `ENVIRONMENTAL_DAMAGE,${this.units(null, dst)}${adv ? `,${adv}` : ""},${kind},${this.damageSuffix(amount, {})}`);
  }

  died(ms: number, dst: Unit) {
    return this.raw(ms, `UNIT_DIED,${this.units(null, dst)},0`);
  }

  encounterStart(ms: number, id: number, name: string) {
    return this.raw(ms, `ENCOUNTER_START,${id},${q(name)},1,5,33`);
  }

  encounterEnd(ms: number, id: number, name: string, success: boolean, fightMs: number) {
    return this.raw(ms, `ENCOUNTER_END,${id},${q(name)},1,5,${success ? 1 : 0},${fightMs}`);
  }

  /** Lines in time order (stable for equal timestamps), as the client writes them. */
  text() {
    const lines = [...this.entries].sort((a, b) => a.ms - b.ms).map((e) => e.line);
    return `${lines.join("\n")}\n`;
  }
}

export const PALADIN = playerUnit("Tor", "0000A001");
export const WARRIOR = playerUnit("Rhune", "0000B002");

/**
 * Tor, level 8 Paladin, two trash pulls. Seal of Righteousness is up before the pull and Judgement does
 * not consume it (Forever). Pull one has a 7 second lull where Judgement was ready, and auto-attack stops.
 */
export function paladinLog(): string {
  const b = new LogBuilder();
  b.level = 8;
  const me = PALADIN;
  const mana = (current: number, cost = 0): Power => ({ type: 0, current, max: 300, cost });
  const boar = mobUnit("Rockhide Boar", 708, 1);
  const wolf = mobUnit("Young Wolf", 299, 2);

  b.cast(-3000, me, null, 21084, "Seal of Righteousness", mana(300, 25));
  b.aura(-3000, "APPLIED", me, me, 21084, "Seal of Righteousness");

  const swings = [0, 2800, 5600, 8400, 11200, 14000, 23800, 26600];
  swings.forEach((t, i) => b.swing(t + 50, me, boar, 18 + (i % 3), { power: mana(260) }));
  for (const t of [1000, 3500, 6000, 8500, 11000, 13500, 16000, 18500, 21000, 23500, 26000]) b.swing(t, boar, me, 6);
  b.cast(1000, me, boar, 20271, "Judgement", mana(275, 15));
  b.damage(1010, me, boar, 20187, "Judgement of Righteousness", 32, { school: "0x2" });
  b.cast(2600, me, boar, 407676, "Holy Strike", mana(260, 20));
  b.damage(2610, me, boar, 407676, "Holy Strike", 24, { school: "0x2" });
  b.cast(11200, me, boar, 20271, "Judgement", mana(250, 15));
  b.damage(11210, me, boar, 20187, "Judgement of Righteousness", 34, { school: "0x2" });
  b.cast(15000, me, boar, 407676, "Holy Strike", mana(240, 20));
  b.damage(15010, me, boar, 407676, "Holy Strike", 25, { school: "0x2" });
  // 7 s lull: Judgement ready from 21.2 s, used at 24.5 s.
  b.cast(24500, me, boar, 20271, "Judgement", mana(230, 15));
  b.damage(24510, me, boar, 20187, "Judgement of Righteousness", 33, { school: "0x2" });
  b.damage(26650, me, boar, 20187, "Judgement of Righteousness", 5, { school: "0x2" });
  b.died(27000, boar);

  // Pull two, 40 s later: the seal drops mid-fight and is recast late.
  const o = 60_000;
  for (let i = 0; i < 7; i++) b.swing(o + i * 2800 + 50, me, wolf, 17, { power: mana(220) });
  for (const t of [800, 3300, 5800, 8300, 10800, 13300, 15800]) b.swing(o + t, wolf, me, 5);
  b.cast(o + 500, me, wolf, 20271, "Judgement", mana(220, 15));
  b.damage(o + 510, me, wolf, 20187, "Judgement of Righteousness", 31, { school: "0x2" });
  b.aura(o + 4000, "REMOVED", me, me, 21084, "Seal of Righteousness");
  b.cast(o + 9000, me, null, 21084, "Seal of Righteousness", mana(205, 25));
  b.aura(o + 9000, "APPLIED", me, me, 21084, "Seal of Righteousness");
  b.cast(o + 10600, me, wolf, 20271, "Judgement", mana(190, 15));
  b.damage(o + 10610, me, wolf, 20187, "Judgement of Righteousness", 30, { school: "0x2" });
  b.died(o + 17000, wolf);
  return b.text();
}

interface TankState {
  rage: number;
}

/**
 * Rhune tanks `target` from `start` for `length` ms: Revenge on dodges and parries, Sunder Armor, Shield Block,
 * Heroic Strike at high rage and one Bloodrage. With `wasteRevengeAt`, one Revenge window goes unused.
 */
function tankFight(b: LogBuilder, me: Unit, target: Unit, start: number, length: number, wasteRevengeAt: number | null, st: TankState) {
  const r = (cost = 0): Power => ({ type: 1, current: st.rage * 10, max: 1000, cost: cost * 10 });
  let gcdFree = 500;
  let lastRevenge = -Infinity;
  let lastTrigger = -Infinity;
  let lastBlock = -Infinity;
  let sunders = 0;
  let mobSwing = 0;
  let n = 0;
  for (let t = 0; t < length; t += 100) {
    const at = start + t;
    if (t === 800) {
      b.cast(at, me, null, 2687, "Bloodrage");
      b.energize(at, me, 2687, "Bloodrage", 10, 1, r());
      st.rage = Math.min(100, st.rage + 10);
    }
    if (t === mobSwing) {
      const kind = n++ % 5;
      if (kind === 1) b.swingMiss(at, target, me, "DODGE");
      else if (kind === 3) b.swingMiss(at, target, me, "PARRY");
      else b.swing(at, target, me, 40, { blocked: kind === 4 ? 20 : 0 });
      if (kind === 1 || kind === 3 || kind === 4) lastTrigger = t;
      st.rage = Math.min(100, st.rage + 6);
      mobSwing += 2000;
    }
    if (t % 2600 === 300) {
      if (st.rage >= 60 && Math.floor(t / 2600) % 2 === 0) {
        st.rage -= 15;
        b.damage(at, me, target, 285, "Heroic Strike", 90, { power: r(15) });
      } else {
        st.rage = Math.min(100, st.rage + 8);
        b.swing(at, me, target, 55, { power: r() });
      }
    }
    if (t - lastBlock >= 10_000 && st.rage >= 10 && t >= 1000) {
      st.rage -= 10;
      b.cast(at, me, null, 2565, "Shield Block", r(10));
      b.aura(at, "APPLIED", me, me, 2565, "Shield Block");
      b.aura(at + 5000, "REMOVED", me, me, 2565, "Shield Block");
      lastBlock = t;
    }
    if (t < gcdFree) continue;
    const wasted = wasteRevengeAt !== null && t >= wasteRevengeAt && t < wasteRevengeAt + 5000;
    const revengeUp = t - lastTrigger < 5000 && lastTrigger > lastRevenge && t - lastRevenge >= 5000;
    if (revengeUp && !wasted && st.rage >= 5) {
      st.rage -= 5;
      b.cast(at, me, target, 6572, "Revenge", r(5));
      b.damage(at + 10, me, target, 6572, "Revenge", 70, { power: r() });
      lastRevenge = t;
      gcdFree = t + 1500;
    } else if (st.rage >= 15 && (sunders < 5 || !revengeUp)) {
      st.rage -= 15;
      b.cast(at, me, target, 7386, "Sunder Armor", r(15));
      sunders++;
      const stacks = Math.min(5, sunders);
      b.aura(at + 10, sunders === 1 ? "APPLIED" : "APPLIED_DOSE", me, target, 7386, "Sunder Armor", "DEBUFF", stacks);
      gcdFree = t + 1500 + (sunders > 5 ? 1500 : 0);
    }
  }
}

/**
 * Rhune, level 30 Protection Warrior (Revenge, Sunder, Shield Block, Heroic Strike, Bloodrage; no Shield
 * Slam yet). One trash pull and one boss encounter. The boar dodges and parries give Revenge windows,
 * one of which is wasted.
 */
export function warriorLog(opts: { start?: Date; tzHours?: number } = {}): string {
  const b = new LogBuilder(opts);
  b.level = 30;
  const me = WARRIOR;
  const st = { rage: 20 };
  const mob = mobUnit("Defias Pillager", 589, 10);
  const boss = mobUnit("Rhahk'Zor", 644, 11);

  b.aura(-10_000, "APPLIED", me, me, 71, "Defensive Stance");
  tankFight(b, me, mob, 0, 24_000, 12_000, st);
  b.died(24_000, mob);
  st.rage = 95;
  b.encounterStart(60_000, 2741, "Rhahk'Zor");
  tankFight(b, me, boss, 60_500, 30_000, null, st);
  b.died(90_500, boss);
  b.encounterEnd(91_000, 2741, "Rhahk'Zor", true, 31_000);
  return b.text();
}

/** A raid member (party or raid affiliation, not the recorder). */
export function raidMember(name: string, id: string): Unit {
  return { guid: `Player-4395-${id}`, name: `${name}-Forever-US`, flags: "0x514" };
}

export const RAID = {
  paladin: raidMember("Aelwyn", "0000C001"),
  priest: raidMember("Sorrel", "0000C002"),
  mage: raidMember("Vexa", "0000C003"),
  rogue: raidMember("Kestrel", "0000C004"),
  hunter: raidMember("Bramble", "0000C005"),
  warlock: raidMember("Nyx", "0000C006"),
  druid: raidMember("Fen", "0000C007"),
  warrior: raidMember("Brakk", "0000C008"),
};

/**
 * Molten Core, Ragnaros (encounter 672, NPC 11502): Rhune tanks with eight raid members. Ragnaros hits the tank
 * with Elemental Fire, knocks melee back with Wrath of Ragnaros and throws Lava Burst; Kestrel dies to a Wrath,
 * Nyx to lava. The kill lands at 60 s.
 */
export function raidLog(opts: { start?: Date; tzHours?: number } = {}): string {
  const b = new LogBuilder(opts);
  b.level = 60;
  const me = WARRIOR;
  const rag = mobUnit("Ragnaros", 11502, 20);
  const R = RAID;
  const st = { rage: 40 };
  const len = 60_000;

  b.aura(-10_000, "APPLIED", me, me, 71, "Defensive Stance");
  b.cast(-8000, R.priest, R.mage, 10938, "Power Word: Fortitude");
  b.aura(-8000, "APPLIED", R.priest, R.mage, 10938, "Power Word: Fortitude");
  b.encounterStart(0, 672, "Ragnaros");
  tankFight(b, me, rag, 500, len - 1000, null, st);

  const dps: [Unit, number, string, number, number][] = [
    [R.mage, 10181, "Frostbolt", 1100, 2600],
    [R.hunter, 20904, "Aimed Shot", 1250, 3100],
    [R.warlock, 11661, "Shadow Bolt", 1050, 2700],
    [R.rogue, 11294, "Sinister Strike", 620, 1300],
    [R.warrior, 23894, "Bloodthirst", 780, 1600],
  ];
  for (const [unit, id, name, amount, every] of dps) {
    for (let t = 900; t < len - 500; t += every) {
      if (unit === R.rogue && t > 31_000) break;
      if (unit === R.warlock && t > 44_000) break;
      b.cast(t, unit, rag, id, name);
      b.damage(t + 20, unit, rag, id, name, amount + ((t / every) % 3) * 40, { crit: (t / every) % 7 === 0 });
    }
  }
  const heals: [Unit, number, string, number, number][] = [
    [R.paladin, 19968, "Holy Light", 1800, 2600],
    [R.priest, 10965, "Greater Heal", 2100, 3200],
    [R.druid, 9841, "Rejuvenation", 540, 3000],
  ];
  for (const [unit, id, name, amount, every] of heals) {
    for (let t = 1500; t < len - 500; t += every) {
      b.cast(t, unit, me, id, name);
      b.heal(t + 20, unit, me, id, name, amount, Math.round(amount * 0.2));
    }
  }

  for (let t = 3000; t < len; t += 3000) b.damage(t, rag, me, 20564, "Elemental Fire", 480, { periodic: true, school: "0x4" });
  for (const t of [12_000, 31_000, 50_000]) {
    for (const [unit, amount] of [[me, 1400], [R.rogue, 2300], [R.warrior, 2200]] as const) {
      b.damage(t, rag, unit, 20566, "Wrath of Ragnaros", amount, { school: "0x4" });
    }
  }
  b.died(31_050, R.rogue);
  for (const t of [18_000, 38_000]) {
    for (const [unit, amount] of [[R.mage, 1900], [R.warlock, 2000], [R.hunter, 1850]] as const) {
      b.damage(t, rag, unit, 21158, "Lava Burst", amount, { school: "0x4" });
    }
  }
  b.environmental(44_100, R.warlock, "Lava", 2400);
  b.died(44_200, R.warlock);
  b.damage(26_000, rag, R.priest, 20565, "Magma Blast", 2600, { school: "0x4" });
  b.died(len, rag);
  b.encounterEnd(len + 200, 672, "Ragnaros", true, len);
  return b.text();
}

export const PARTY = {
  priest: raidMember("Sorrel", "0000D001"),
  mage: raidMember("Vexa", "0000D002"),
  rogue: raidMember("Kestrel", "0000D003"),
  warlock: raidMember("Nyx", "0000D004"),
};

/** Party damage and healing on `target` from `start` for `length` ms (Rhune tanks it). */
function partyFight(b: LogBuilder, target: Unit, start: number, length: number, st: TankState, stopAt = new Map<Unit, number>()) {
  const P = PARTY;
  tankFight(b, WARRIOR, target, start + 300, length - 300, null, st);
  const dps: [Unit, number, string, number, number][] = [
    [P.mage, 8406, "Frostbolt", 190, 2700],
    [P.rogue, 1758, "Sinister Strike", 95, 1400],
    [P.warlock, 1106, "Shadow Bolt", 175, 3000],
  ];
  for (const [unit, id, name, amount, every] of dps) {
    for (let t = 600; t < length - 200 && start + t < (stopAt.get(unit) ?? Infinity); t += every) {
      b.cast(start + t, unit, target, id, name);
      b.damage(start + t + 20, unit, target, id, name, amount + ((t / every) % 3) * 12, { crit: (t / every) % 6 === 0 });
    }
  }
  for (let t = 1500; t < length - 200 && start + t < (stopAt.get(P.priest) ?? Infinity); t += 2800) {
    b.cast(start + t, P.priest, WARRIOR, 2055, "Heal");
    b.heal(start + t + 20, P.priest, WARRIOR, 2055, "Heal", 310, 40);
  }
}

/**
 * The Deadmines with a level 21 party: Rhune tanks, Sorrel heals, Vexa, Kestrel and Nyx deal damage. Classic Era
 * writes no ENCOUNTER_START in dungeons, so the bosses are known only by their units. A short trash pull, a quick
 * Rhahk'Zor kill (under the 20 s trash cutoff), more trash, Mr. Smite, and Edwin VanCleef, whose Blackguards kill
 * Vexa. The whole run takes about four minutes.
 */
export function deadminesLog(opts: { start?: Date; tzHours?: number } = {}): string {
  const b = new LogBuilder(opts);
  b.level = 21;
  const me = WARRIOR;
  const P = PARTY;
  const st = { rage: 20 };
  b.aura(-10_000, "APPLIED", me, me, 71, "Defensive Stance");
  b.cast(-8000, P.priest, me, 1244, "Power Word: Fortitude");
  b.aura(-8000, "APPLIED", P.priest, me, 1244, "Power Word: Fortitude");

  const miner = mobUnit("Defias Miner", 598, 30);
  partyFight(b, miner, 0, 12_000, st);
  b.died(12_000, miner);

  const rhahk = mobUnit("Rhahk'Zor", 644, 31);
  st.rage = 30;
  partyFight(b, rhahk, 30_000, 16_000, st);
  for (const t of [34_000, 42_000]) b.damage(t, rhahk, me, 6304, "Rhahk'Zor Slam", 210);
  b.died(46_000, rhahk);

  const overseer = mobUnit("Defias Overseer", 634, 32);
  st.rage = 20;
  partyFight(b, overseer, 70_000, 14_000, st);
  b.died(84_000, overseer);

  const smite = mobUnit("Mr. Smite", 646, 33);
  st.rage = 30;
  partyFight(b, smite, 110_000, 38_000, st);
  for (const t of [122_000, 136_000]) {
    for (const [unit, amount] of [[me, 95], [P.rogue, 110]] as const) b.damage(t, smite, unit, 6432, "Smite Stomp", amount);
    b.aura(t, "APPLIED", smite, P.rogue, 6432, "Smite Stomp", "DEBUFF");
  }
  for (const t of [128_000, 142_000]) b.damage(t, smite, me, 6435, "Smite Slam", 260);
  b.died(148_000, smite);

  const vancleef = mobUnit("Edwin VanCleef", 639, 34);
  st.rage = 30;
  partyFight(b, vancleef, 180_000, 42_000, st, new Map([[P.mage, 213_800]]));
  b.cast(181_000, vancleef, null, 674, "Dual Wield");
  for (const t of [186_000, 197_000, 209_000]) {
    b.damage(t, vancleef, me, 3391, "Thrash", 140);
    b.damage(t + 300, vancleef, me, 3391, "Thrash", 135);
  }
  b.cast(200_000, vancleef, null, 5200, "VanCleef's Allies");
  const guards = [mobUnit("Defias Blackguard", 636, 35), mobUnit("Defias Blackguard", 636, 36)];
  for (const [i, guard] of guards.entries()) {
    for (let t = 201_000 + i * 400; t < 214_000; t += 1800) b.swing(t, guard, P.mage, 70 + i * 6);
    b.swing(201_500 + i * 300, P.rogue, guard, 60);
  }
  b.died(213_800, P.mage);
  for (const [i, guard] of guards.entries()) {
    b.damage(215_000 + i * 900, P.warlock, guard, 1106, "Shadow Bolt", 190);
    b.died(218_000 + i * 900, guard);
  }
  b.died(222_000, vancleef);
  return b.text();
}

/**
 * The Stockade with a level 26 party (same group as the Deadmines run), again without ENCOUNTER_START. Prisoner
 * trash between the bosses; a quick Targorr kill (under the 20 s trash cutoff); Kam Deepfury; a wipe on Hamhock,
 * pulled with two Defias Prisoners, then a clean kill after the run back; and Bazil Thredd, whose Smoke Bomb
 * stuns the group. Battle Shout, Dual Wield and Bloodlust are casts that never hit a player. About five and a half
 * minutes.
 */
export function stockadeLog(opts: { start?: Date; tzHours?: number } = {}): string {
  const b = new LogBuilder(opts);
  b.level = 26;
  const me = WARRIOR;
  const P = PARTY;
  const st = { rage: 20 };
  b.aura(-10_000, "APPLIED", me, me, 71, "Defensive Stance");
  b.cast(-8000, P.priest, me, 1244, "Power Word: Fortitude");
  b.aura(-8000, "APPLIED", P.priest, me, 1244, "Power Word: Fortitude");

  const prisoner = mobUnit("Defias Prisoner", 1706, 40);
  partyFight(b, prisoner, 0, 12_000, st);
  b.cast(4000, prisoner, me, 6713, "Disarm");
  b.aura(4000, "APPLIED", prisoner, me, 6713, "Disarm", "DEBUFF");
  b.aura(9000, "REMOVED", prisoner, me, 6713, "Disarm", "DEBUFF");
  b.died(12_000, prisoner);

  const captive = mobUnit("Defias Captive", 1707, 41);
  st.rage = 20;
  partyFight(b, captive, 25_000, 13_000, st);
  b.damage(30_000, captive, P.rogue, 7159, "Backstab", 120);
  b.aura(31_000, "APPLIED", captive, me, 3427, "Infected Wound", "DEBUFF");
  b.died(38_000, captive);

  const targorr = mobUnit("Targorr the Dread", 1696, 42);
  st.rage = 30;
  partyFight(b, targorr, 55_000, 17_000, st);
  b.cast(55_400, targorr, null, 674, "Dual Wield");
  for (const t of [59_000, 65_500]) {
    b.damage(t, targorr, me, 3391, "Thrash", 120);
    b.damage(t + 250, targorr, me, 3391, "Thrash", 115);
  }
  b.cast(67_000, targorr, null, 8599, "Enrage");
  b.aura(67_000, "APPLIED", targorr, targorr, 8599, "Enrage");
  b.died(72_000, targorr);

  const kam = mobUnit("Kam Deepfury", 1666, 43);
  st.rage = 20;
  partyFight(b, kam, 90_000, 30_000, st);
  b.cast(90_500, kam, null, 7164, "Defensive Stance");
  for (const t of [97_000, 109_000]) b.damage(t, kam, me, 8242, "Shield Slam", 150);
  b.died(120_000, kam);

  // Hamhock and two prisoners: the healer goes down first and the group follows.
  const hamhock = mobUnit("Hamhock", 1717, 44);
  const deaths = new Map<Unit, number>([[P.priest, 158_000], [P.mage, 160_000], [P.warlock, 161_500], [P.rogue, 163_000], [me, 164_000]]);
  st.rage = 30;
  partyFight(b, hamhock, 140_000, 24_000, st, deaths);
  b.cast(141_000, hamhock, null, 6742, "Bloodlust");
  b.aura(141_000, "APPLIED", hamhock, hamhock, 6742, "Bloodlust");
  const adds = [mobUnit("Defias Prisoner", 1706, 45), mobUnit("Defias Prisoner", 1706, 46)];
  for (const [i, add] of adds.entries()) {
    for (let t = 142_000 + i * 500; t < 158_000; t += 1700) b.swing(t, add, P.priest, 65 + i * 5);
  }
  for (const t of [146_000, 153_000]) {
    b.castStart(t - 2000, hamhock, 421, "Chain Lightning");
    b.cast(t, hamhock, me, 421, "Chain Lightning");
    for (const [unit, amount] of [[me, 160], [P.mage, 140], [P.warlock, 130]] as const) b.damage(t + 50, hamhock, unit, 421, "Chain Lightning", amount, { school: "0x8" });
  }
  b.castStart(157_800, hamhock, 421, "Chain Lightning");
  b.cast(159_800, hamhock, P.mage, 421, "Chain Lightning");
  for (const [unit, amount] of [[P.mage, 180], [P.warlock, 170], [P.rogue, 150]] as const) b.damage(159_850, hamhock, unit, 421, "Chain Lightning", amount, { school: "0x8" });
  for (const t of [161_000, 162_600, 163_600]) b.swing(t, hamhock, t < 163_000 ? P.warlock : me, 160);
  b.swing(162_800, adds[0]!, P.rogue, 90);
  for (const [unit, t] of deaths) b.died(t, unit);

  // After the run back: a clean Hamhock kill, with Chain Lightning interrupted once and Bloodlust dispelled.
  st.rage = 30;
  partyFight(b, hamhock, 215_000, 34_000, st);
  b.cast(216_000, hamhock, null, 6742, "Bloodlust");
  b.aura(216_000, "APPLIED", hamhock, hamhock, 6742, "Bloodlust");
  b.aura(218_000, "REMOVED", hamhock, hamhock, 6742, "Bloodlust");
  b.castStart(222_000, hamhock, 421, "Chain Lightning");
  b.cast(222_400, P.rogue, hamhock, 1766, "Kick");
  b.castStart(236_000, hamhock, 421, "Chain Lightning");
  b.cast(238_000, hamhock, me, 421, "Chain Lightning");
  for (const [unit, amount] of [[me, 150], [P.rogue, 135]] as const) b.damage(238_050, hamhock, unit, 421, "Chain Lightning", amount, { school: "0x8" });
  b.died(249_000, hamhock);

  const insurgent = mobUnit("Defias Insurgent", 1715, 47);
  st.rage = 20;
  partyFight(b, insurgent, 265_000, 13_000, st);
  b.cast(265_500, insurgent, null, 9128, "Battle Shout");
  b.cast(268_000, insurgent, null, 13730, "Demoralizing Shout");
  b.aura(268_000, "APPLIED", insurgent, me, 13730, "Demoralizing Shout", "DEBUFF");
  b.died(278_000, insurgent);

  const bazil = mobUnit("Bazil Thredd", 1716, 48);
  st.rage = 30;
  partyFight(b, bazil, 295_000, 40_000, st);
  b.cast(295_400, bazil, null, 674, "Dual Wield");
  b.cast(297_000, bazil, null, 9128, "Battle Shout");
  b.cast(318_000, bazil, null, 9128, "Battle Shout");
  for (const t of [305_000, 324_000]) {
    b.cast(t, bazil, me, 7964, "Smoke Bomb");
    for (const unit of [me, P.rogue, P.priest]) {
      b.aura(t + 20, "APPLIED", bazil, unit, 7964, "Smoke Bomb", "DEBUFF");
      b.aura(t + 4020, "REMOVED", bazil, unit, 7964, "Smoke Bomb", "DEBUFF");
    }
  }
  b.died(335_000, bazil);
  return b.text();
}
