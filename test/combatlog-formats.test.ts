import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitLines } from "@/lib/combatlog/lines";
import { normalizeEvent } from "@/lib/combatlog/normalize";
import { tokenizeLine } from "@/lib/combatlog/tokenizer";
import { LiveSession } from "@/lib/vigil/live";
import { fightReportSchema } from "@/lib/vigil/report";
import { asBossFight, formatProblem } from "../src/core/uploader";

/**
 * Trimmed from a TBC Anniversary (2.5.6) log with names anonymised: a level 65 Retribution Paladin and a Hunter
 * with a pet in Nagrand. The client writes COMBAT_LOG_VERSION 9 with an 18-field advanced block.
 */
const text = readFileSync(join(__dirname, "fixtures/logs/tbc-anniversary-2.5.6.txt"), "utf8");
const PALADIN = "Player-6064-0000A001";

describe("TBC Anniversary 2.5.6 log in the companion", () => {
  const live = new LiveSession({ fallbackYear: 2026 });
  for (const line of splitLines(text)) live.pushLine(line);
  live.finish();
  const reports = live.drainCompleted().map((c) => asBossFight(c.report));

  it("finds the recorder without claiming the item level as a level", () => {
    expect(live.header).toMatchObject({ version: 9, advanced: true, build: "2.5.6" });
    expect(live.player).toEqual({ guid: PALADIN, name: "Paladin", level: null });
  });

  it("reports sane damage and DPS for each fight", () => {
    expect(reports.map((r) => [r.fight.label, r.fight.kind, r.totals.damage])).toEqual([
      ["Talbuk Stag +2", "trash", 9138],
      ["Clefthoof", "trash", 1130],
    ]);
    const stags = reports[0]!;
    expect(stags.fight.durationMs).toBeGreaterThan(45_000);
    expect(stags.totals.dps).toBeGreaterThan(150);
    expect(stags.totals.dps).toBeLessThan(250);
  });

  it("uploads: every report passes the site's schema", () => {
    for (const r of reports) {
      expect(r.player.level).toBeNull();
      expect(formatProblem(r)).toBeNull();
      expect(() => fightReportSchema.parse(r)).not.toThrow();
    }
  });
});

describe("advanced block layouts", () => {
  const PLAYER = `Player-6064-0000A001,"Paladin-Dreamscythe-US",0x511,0x80000000`;
  const block = (extra: number, level: string) =>
    ["Player-6064-0000A001", "0000000000000000", 100, 100, 1206, 0, 6385, ...Array<number>(extra).fill(0), 0, 2974, 3152, 0, "-1492.98", "6421.02", 1951, "1.8407", level].join(",");
  const read = (body: string, version: number, build: string) =>
    normalizeEvent(tokenizeLine(`9/28/2026 19:12:15.745-7  ${body}`)!, { header: { version, advanced: true, build, projectId: null } })!;

  it.each([
    { fields: 16, version: 19, build: "8.3.0" },
    { fields: 17, version: 9, build: "1.15.7" },
    { fields: 17, version: 22, build: "12.1.5" },
    { fields: 18, version: 9, build: "2.5.6" },
    { fields: 19, version: 9, build: "2.5.6" },
    { fields: 20, version: 22, build: "12.1.5" },
  ])("reads a $fields-field block from build $build", ({ fields, version, build }) => {
    const ev = read(`SWING_DAMAGE,${PLAYER},${PLAYER},${block(fields - 16, "60")},645,518,-1,1,0,0,0,1,nil,nil`, version, build);
    expect(ev).toMatchObject({ amount: 645, overkill: 0, critical: true });
    expect(ev.adv).toMatchObject({ power: [2974], maxPower: [3152], x: -1492.98, y: 6421.02, level: 60 });
  });

  it("drops a player level over the client's cap (item level on modern clients)", () => {
    expect(read(`SWING_DAMAGE,${PLAYER},${PLAYER},${block(2, "87")},645,518,-1,1,0,0,0,1,nil,nil`, 9, "2.5.6").adv!.level).toBeUndefined();
    expect(read(`SWING_DAMAGE,${PLAYER},${PLAYER},${block(1, "87")},645,645,-1,1,0,0,0,1,nil,nil,nil`, 22, "12.1.5").adv!.level).toBe(87);
  });
});
