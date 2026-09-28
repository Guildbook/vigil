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

/**
 * Rhune, level 30 Protection Warrior (Revenge, Sunder, Shield Block, Heroic Strike, Bloodrage; no Shield
 * Slam yet). One trash pull and one boss encounter. The boar dodges and parries give Revenge windows,
 * one of which is wasted.
 */
export function warriorLog(opts: { start?: Date; tzHours?: number } = {}): string {
  const b = new LogBuilder(opts);
  b.level = 30;
  const me = WARRIOR;
  let rage = 20;
  const r = (cost = 0): Power => ({ type: 1, current: rage * 10, max: 1000, cost: cost * 10 });
  const mob = mobUnit("Defias Pillager", 589, 10);
  const boss = mobUnit("Rhahk'Zor", 644, 11);

  b.aura(-10_000, "APPLIED", me, me, 71, "Defensive Stance");

  const fight = (start: number, target: Unit, length: number, wasteRevengeAt: number | null) => {
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
        rage = Math.min(100, rage + 10);
      }
      if (t === mobSwing) {
        const kind = n++ % 5;
        if (kind === 1) b.swingMiss(at, target, me, "DODGE");
        else if (kind === 3) b.swingMiss(at, target, me, "PARRY");
        else b.swing(at, target, me, 40, { blocked: kind === 4 ? 20 : 0 });
        if (kind === 1 || kind === 3 || kind === 4) lastTrigger = t;
        rage = Math.min(100, rage + 6);
        mobSwing += 2000;
      }
      if (t % 2600 === 300) {
        if (rage >= 60 && Math.floor(t / 2600) % 2 === 0) {
          rage -= 15;
          b.damage(at, me, target, 285, "Heroic Strike", 90, { power: r(15) });
        } else {
          rage = Math.min(100, rage + 8);
          b.swing(at, me, target, 55, { power: r() });
        }
      }
      if (t - lastBlock >= 10_000 && rage >= 10 && t >= 1000) {
        rage -= 10;
        b.cast(at, me, null, 2565, "Shield Block", r(10));
        b.aura(at, "APPLIED", me, me, 2565, "Shield Block");
        b.aura(at + 5000, "REMOVED", me, me, 2565, "Shield Block");
        lastBlock = t;
      }
      if (t < gcdFree) continue;
      const wasted = wasteRevengeAt !== null && t >= wasteRevengeAt && t < wasteRevengeAt + 5000;
      const revengeUp = t - lastTrigger < 5000 && lastTrigger > lastRevenge && t - lastRevenge >= 5000;
      if (revengeUp && !wasted && rage >= 5) {
        rage -= 5;
        b.cast(at, me, target, 6572, "Revenge", r(5));
        b.damage(at + 10, me, target, 6572, "Revenge", 70, { power: r() });
        lastRevenge = t;
        gcdFree = t + 1500;
      } else if (rage >= 15 && (sunders < 5 || !revengeUp)) {
        rage -= 15;
        b.cast(at, me, target, 7386, "Sunder Armor", r(15));
        sunders++;
        const stacks = Math.min(5, sunders);
        b.aura(at + 10, sunders === 1 ? "APPLIED" : "APPLIED_DOSE", me, target, 7386, "Sunder Armor", "DEBUFF", stacks);
        gcdFree = t + 1500 + (sunders > 5 ? 1500 : 0);
      }
    }
    b.died(start + length, target);
  };

  fight(0, mob, 24_000, 12_000);
  rage = 95;
  b.encounterStart(60_000, 1144, "Rhahk'Zor");
  fight(60_500, boss, 30_000, null);
  b.encounterEnd(91_000, 1144, "Rhahk'Zor", true, 31_000);
  return b.text();
}
