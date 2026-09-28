import { describe, expect, it } from "vitest";
import bossSpells from "../src/data/boss-spells.json";
import { BOSSES, RAIDS } from "../src/data/bosses";
import { bossForEncounter, bossForUnit, isEncounterUnit, matchAbility } from "../src/core/intel";
import { SpellIcons } from "../src/core/media";

const clientNames = (bossSpells as { spells: Record<string, string | null> }).spells;
const icons = new SpellIcons();

/** ENCOUNTER_START IDs from the Classic Era client's DungeonEncounter table (build 1.15.9), in instance order. */
const DUNGEON_ENCOUNTERS: Record<string, number[]> = {
  mc: [663, 664, 665, 666, 667, 668, 669, 670, 671, 672],
  onyxia: [1084],
  bwl: [610, 611, 612, 613, 614, 615, 616, 617],
  zg: [785, 784, 786, 787, 788, 789, 790, 791, 792, 793],
  aq20: [718, 719, 720, 721, 722, 723],
  aq40: [709, 710, 711, 712, 713, 714, 715, 716, 717],
  naxx: [1107, 1110, 1116, 1117, 1112, 1115, 1113, 1109, 1121, 1118, 1111, 1108, 1120, 1119, 1114],
};

describe("boss intel data", () => {
  it("covers every Forever raid with the client's encounter IDs", () => {
    for (const raid of RAIDS) {
      expect(BOSSES.filter((b) => b.raid === raid.id).map((b) => b.encounterId), raid.name).toEqual(DUNGEON_ENCOUNTERS[raid.id]);
    }
  });

  it("has unique keys, encounter IDs and ability keys", () => {
    expect(new Set(BOSSES.map((b) => b.key)).size).toBe(BOSSES.length);
    expect(new Set(BOSSES.map((b) => b.encounterId)).size).toBe(BOSSES.length);
    for (const b of BOSSES) expect(new Set(b.abilities.map((a) => a.key)).size, b.name).toBe(b.abilities.length);
  });

  it("writes up Molten Core and Onyxia in full", () => {
    for (const b of BOSSES.filter((x) => x.raid === "mc" || x.raid === "onyxia")) {
      expect(b.status, b.name).toBe("full");
      expect(b.abilities.length, b.name).toBeGreaterThanOrEqual(3);
      expect(b.displayId, b.name).not.toBeNull();
      expect(b.npcIds.length, b.name).toBeGreaterThan(0);
    }
  });

  it("uses spell IDs whose client names match the ability", () => {
    for (const b of BOSSES) {
      for (const a of b.abilities) {
        const allowed = new Set([a.name, ...(a.logNames ?? [])]);
        for (const id of a.spellIds) {
          expect(clientNames[id], `${b.name}: ${a.name} (${id}) is missing from boss-spells.json; run pnpm icons:generate`).toBeDefined();
          expect(allowed.has(clientNames[id]!), `${b.name}: ${a.name} (${id}) is "${clientNames[id]}" in the client`).toBe(true);
        }
        expect(a.icon ?? icons.byId(a.spellIds[0]!), `${b.name}: ${a.name} has no icon`).toBeTruthy();
      }
    }
  });

  it("keeps descriptions short and in house style", () => {
    for (const b of BOSSES) {
      for (const a of b.abilities) {
        for (const text of [a.summary, a.counter, a.uncertain ?? ""]) {
          expect(text.length, `${b.name}: ${a.name}`).toBeLessThan(160);
          expect(text).not.toMatch(/\u00b7/);
        }
      }
    }
  });
});

describe("intel lookups", () => {
  it("finds bosses by encounter, NPC ID or unit name", () => {
    expect(bossForEncounter(672)?.key).toBe("ragnaros");
    expect(bossForEncounter(1)).toBeNull();
    expect(bossForUnit(11502, "Anything")?.key).toBe("ragnaros");
    expect(bossForUnit(null, "Onyxia")?.key).toBe("onyxia");
    expect(bossForUnit(123, "Emperor Vek'lor")?.key).toBe("twin-emperors");
    expect(bossForUnit(123, "Molten Giant")).toBeNull();
  });

  it("matches logged abilities by spell ID, then by name", () => {
    const ony = bossForEncounter(1084)!;
    expect(matchAbility(ony, 18435, "Flame Breath")?.key).toBe("flame-breath");
    expect(matchAbility(ony, 18590, "Breath")?.key).toBe("deep-breath");
    expect(matchAbility(ony, null, "bellowing roar")?.key).toBe("bellowing-roar");
    expect(matchAbility(ony, 1, "Melee")).toBeNull();
    const garr = bossForEncounter(666)!;
    expect(isEncounterUnit(garr, 12099)).toBe(true);
    expect(isEncounterUnit(garr, 11502)).toBe(false);
  });
});
