import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitLines } from "@/lib/combatlog/lines";
import { normalizeEvent } from "@/lib/combatlog/normalize";
import { parseHeader, tokenizeLine } from "@/lib/combatlog/tokenizer";
import { detectGameVersion } from "@/lib/vigil/game-version";
import { LiveSession } from "@/lib/vigil/live";
import { fightReportSchema } from "@/lib/vigil/report";
import { asBossFight, formatProblem } from "../src/core/uploader";

/**
 * Trimmed from a WoW: Forever beta (1.60.1) log with names anonymised: a low-level Paladin in Elwynn Forest among
 * other players. The header says ADVANCED_LOG_ENABLED,0 yet every line carries a 19-field advanced block (three
 * fields between armor and powerType), players' level column holds item level, and damage ends with ST/AOE.
 */
const text = readFileSync(join(__dirname, "fixtures/logs/forever-1.60.1.txt"), "utf8");
const PALADIN = "Player-4620-0000A001";

describe("WoW: Forever 1.60.1 log in the companion", () => {
  const live = new LiveSession({ fallbackYear: 2026 });
  for (const line of splitLines(text)) live.pushLine(line);
  live.finish();
  const reports = live.drainCompleted().map((c) => asBossFight(c.report));

  it("reads the header, trusts the advanced block it denies, and finds the recorder", () => {
    expect(live.header).toMatchObject({ version: 22, advanced: true, build: "1.60.1", projectId: 18 });
    expect(live.player).toEqual({ guid: PALADIN, name: "Paladin", level: null });
  });

  it("reports sane damage and DPS for each fight", () => {
    expect(reports.map((r) => [r.fight.label, r.fight.kind, r.totals.damage])).toEqual([
      ["Mangy Wolf", "trash", 127],
      ["Forest Spider +1", "trash", 246],
      ["Murloc +1", "trash", 275],
      ["Murloc", "trash", 150],
    ]);
    for (const r of reports) {
      expect(r.totals.dps).toBeGreaterThan(5);
      expect(r.totals.dps).toBeLessThan(40);
    }
  });

  it("uploads as WoW: Forever: every report passes the site's schema", () => {
    for (const r of reports) {
      expect(r.gameVersion).toBe("forever");
      expect(r.log).toMatchObject({ advanced: true, projectId: 18 });
      expect(r.player.level).toBeNull();
      expect(formatProblem(r)).toBeNull();
      expect(() => fightReportSchema.parse(r)).not.toThrow();
    }
  });
});

/** A second login appended to the same file, as the client does: a low-level Warrior killing two Prairie Stalkers. */
const relog = readFileSync(join(__dirname, "fixtures/logs/forever-1.60.1-relog.txt"), "utf8");
const WARRIOR = "Player-4620-0000A002";

describe("WoW: Forever log with a second character logged into the same file", () => {
  const live = new LiveSession({ fallbackYear: 2026 });
  for (const line of splitLines(text + relog)) live.pushLine(line);
  live.finish();
  const reports = live.drainCompleted().map((c) => asBossFight(c.report));

  it("follows the new recorder after the second header", () => {
    expect(live.player).toEqual({ guid: WARRIOR, name: "Warrior", level: null });
    expect(reports.map((r) => [r.player.name, r.fight.label, r.totals.damage])).toEqual([
      ["Paladin", "Mangy Wolf", 127],
      ["Paladin", "Forest Spider +1", 246],
      ["Paladin", "Murloc +1", 275],
      ["Paladin", "Murloc", 150],
      // The first Stalker died to a Charge and one swing in under 2 s, below the trash minimum.
      ["Warrior", "Prairie Stalker", 246],
    ]);
    const warrior = reports.at(-1)!;
    expect(warrior.gameVersion).toBe("forever");
    expect(() => fightReportSchema.parse(warrior)).not.toThrow();
  });

  it("reads rage energizes, avoidance and the rage cost in tenths", () => {
    const events = [...splitLines(relog)]
      .map((l) => tokenizeLine(l))
      .filter((t) => t !== null)
      .map((t) => normalizeEvent(t, { header: parseHeader(tokenizeLine(relog.split(/\r?\n/)[0]!)!.fields) }));
    expect(events.find((e) => e?.type === "SPELL_ENERGIZE")).toMatchObject({ spellName: "Charge", amount: 9, powerType: 1 });
    expect(events.filter((e) => e?.type === "SWING_MISSED").map((e) => e!.missType)).toEqual(["DODGE", "PARRY"]);
    const hs = events.find((e) => e?.type === "SPELL_CAST_SUCCESS" && e.spellName === "Heroic Strike")!;
    expect(hs.adv).toMatchObject({ powerType: [1], maxPower: [1000], powerCost: 150 });
  });
});

describe("Forever line layout", () => {
  const read = (body: string) => {
    const header = parseHeader(tokenizeLine(text.split(/\r?\n/)[0]!)!.fields);
    return normalizeEvent(tokenizeLine(`9/29/2026 20:40:00.000-7  ${body}`)!, { header })!;
  };
  const block = (guid: string, level: number) =>
    `${guid},0000000000000000,214,214,118,0,545,0,0,0,0,214,234,0,-9354.16,250.07,1429,4.0567,${level}`;
  const WOLF = "Creature-0-4621-0-116-525-00003C834B";
  const units = `${PALADIN},"Paladin-ClassicBetaPvE2-",0x511,0x80000000,${WOLF},"Mangy Wolf",0x10a48,0x80000000`;

  it("reads damage after the 19-field block, with baseAmount and the trailing ST", () => {
    const ev = read(`SPELL_DAMAGE,${units},20271,"Judgement",0x2,${block(WOLF, 6)},41,40,-1,2,0,0,0,1,nil,nil,ST`);
    expect(ev).toMatchObject({ amount: 41, overkill: 0, critical: true, offHand: false });
    expect(ev.adv).toMatchObject({ guid: WOLF, level: 6, x: -9354.16 });
  });

  it("does not take a player's item level for a level", () => {
    const ev = read(`SWING_DAMAGE,${units},${block(PALADIN, 3)},23,26,-1,1,0,0,0,nil,nil,nil`);
    expect(ev.amount).toBe(23);
    expect(ev.adv!.level).toBeUndefined();
  });

  it("reads DAMAGE_SHIELD and the environment type after the block", () => {
    expect(read(`DAMAGE_SHIELD,${units},782,"Thorns",0x8,${block(WOLF, 6)},9,9,-1,8,0,0,0,nil,nil,nil,ST`).amount).toBe(9);
    const fall = read(`ENVIRONMENTAL_DAMAGE,0000000000000000,nil,0x80000000,0x80000000,${units.split(",").slice(0, 4).join(",")},${block(PALADIN, 3)},Falling,19,19,0,1,0,0,0,nil,nil,nil`);
    expect(fall).toMatchObject({ spellName: "Falling", amount: 19 });
  });
});

describe("detectGameVersion for Forever and Classic Era", () => {
  it("reads Forever from its project id or its 1.60 build", () => {
    expect(detectGameVersion({ projectId: 18, build: "1.60.1" })).toEqual({ version: "forever", source: "header" });
    expect(detectGameVersion({ projectId: null, build: "1.60.1" })).toEqual({ version: "forever", source: "header" });
    expect(detectGameVersion({ projectId: 18, build: "1.60.1", flavor: "_classic_era_" }).version).toBe("forever");
  });

  it("keeps Classic Era apart", () => {
    expect(detectGameVersion({ projectId: 2, build: "1.15.7", flavor: "_classic_era_" }).version).toBe("era");
    expect(detectGameVersion({ projectId: 2, build: "1.15.7" }).version).toBeNull();
    expect(detectGameVersion({ projectId: 2, build: "1.60.1" }).version).toBeNull();
  });
});
