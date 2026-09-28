import { describe, expect, it } from "vitest";
import bossSpells from "../src/data/boss-spells.json";
import { BOSSES, DUNGEONS, INSTANCES, RAIDS } from "../src/data/bosses";
import { bossAmong, bossForEncounter, bossForUnit, isEncounterUnit, matchAbility, searchBosses } from "../src/core/intel";
import { SpellIcons } from "../src/core/media";

const clientNames = (bossSpells as { spells: Record<string, string | null> }).spells;
const icons = new SpellIcons();

/**
 * ENCOUNTER_START IDs from the Classic Era client's DungeonEncounter table (build 1.15.9), in the table's order.
 * Dungeons use the 5-player rows; the Season of Discovery raid versions of Blackfathom Deeps, Gnomeregan and the
 * Sunken Temple are left out.
 */
const ENCOUNTERS: Record<string, number[]> = {
  rfc: [2732, 2733, 2734, 2735],
  wc: [585, 586, 587, 588, 589, 590, 591, 592],
  deadmines: [2741, 2742, 2743, 2744, 2745, 2746, 2747],
  sfk: [2748, 2749, 2750, 2751, 2752, 2753, 2754, 2755],
  bfd: [2761, 2762, 2763, 2764, 2765, 2766, 2767],
  stockade: [2756, 2757, 2758, 2759, 2760],
  gnomeregan: [2768, 2769, 2770, 2771, 2772],
  rfk: [2773, 2774, 2775, 2776, 2777, 2778],
  "sm-graveyard": [444, 2779],
  "sm-library": [446, 447],
  "sm-armory": [448],
  "sm-cathedral": [449, 450],
  rfd: [2780, 2781, 2782, 2783, 2784, 2785],
  uldaman: [547, 548, 549, 1887, 551, 552, 553, 554],
  zf: [593, 594, 595, 596, 597, 598, 599, 600],
  maraudon: [422, 423, 427, 424, 425, 426, 428, 429],
  st: [492, 488, 486, 487, 490, 491, 493, 2814],
  brd: [227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 2791, 242, 243, 244, 2789, 2790],
  lbrs: [267, 268, 269, 270, 271, 272, 274, 273, 275],
  ubrs: [3062, 3063, 3068, 3069, 3070],
  "dm-east": [343, 344, 345, 2792, 346],
  "dm-west": [350, 347, 348, 349, 361, 2793, 2794],
  "dm-north": [362, 363, 364, 365, 366, 367, 368],
  scholomance: [2805, 2804, 2811, 2809, 2813, 3055, 2810, 2803, 2802, 2808, 2812, 2807, 2806, 2801],
  "strat-live": [473, 474, 476, 475, 477, 478, 472, 2796, 2798, 2799],
  "strat-undead": [479, 480, 481, 482, 483, 484, 2795, 2797, 2800],
  mc: [663, 664, 665, 666, 667, 668, 669, 670, 671, 672],
  onyxia: [1084],
  bwl: [610, 611, 612, 613, 614, 615, 616, 617],
  zg: [785, 784, 786, 787, 788, 789, 790, 791, 792, 793],
  aq20: [718, 719, 720, 721, 722, 723],
  aq40: [709, 710, 711, 712, 713, 714, 715, 716, 717],
  naxx: [1107, 1110, 1116, 1117, 1112, 1115, 1113, 1109, 1121, 1118, 1111, 1108, 1120, 1119, 1114],
};

/** The leveling staples and endgame dungeons, written up in depth. */
const PRIORITY = ["deadmines", "sm-graveyard", "sm-library", "sm-armory", "sm-cathedral", "brd", "lbrs", "ubrs", "strat-live", "strat-undead", "scholomance", "dm-east", "dm-west", "dm-north"];

describe("boss intel data", () => {
  it("covers every raid and dungeon with the client's encounter IDs", () => {
    expect(INSTANCES.map((i) => i.id).sort()).toEqual(Object.keys(ENCOUNTERS).sort());
    for (const inst of INSTANCES) {
      const ids = BOSSES.filter((b) => b.instance === inst.id && b.encounterId !== null).map((b) => b.encounterId);
      expect(ids, inst.name).toEqual(ENCOUNTERS[inst.id]);
    }
    expect(BOSSES.every((b) => INSTANCES.some((i) => i.id === b.instance))).toBe(true);
  });

  it("gives every dungeon a level range and a group size, and every raid neither range nor dungeon kind", () => {
    for (const d of DUNGEONS) {
      expect(d.kind, d.name).toBe("dungeon");
      expect(d.levels![0], d.name).toBeLessThan(d.levels![1]);
      expect([5, 10], d.name).toContain(d.size);
    }
    for (const r of RAIDS) {
      expect(r.kind, r.name).toBe("raid");
      expect(r.levels, r.name).toBeUndefined();
    }
  });

  it("has unique keys, encounter IDs, NPC IDs and ability keys", () => {
    expect(new Set(BOSSES.map((b) => b.key)).size).toBe(BOSSES.length);
    const encounters = BOSSES.flatMap((b) => [...(b.encounterId === null ? [] : [b.encounterId]), ...(b.altEncounterIds ?? [])]);
    expect(new Set(encounters).size).toBe(encounters.length);
    const npcs = BOSSES.flatMap((b) => b.npcIds);
    expect(new Set(npcs).size).toBe(npcs.length);
    const names = BOSSES.flatMap((b) => b.unitNames.map((n) => n.toLowerCase()));
    expect(new Set(names).size).toBe(names.length);
    for (const b of BOSSES) expect(new Set(b.abilities.map((a) => a.key)).size, b.name).toBe(b.abilities.length);
  });

  it("writes up Molten Core and Onyxia in full", () => {
    for (const b of BOSSES.filter((x) => x.instance === "mc" || x.instance === "onyxia")) {
      expect(b.status, b.name).toBe("full");
      expect(b.abilities.length, b.name).toBeGreaterThanOrEqual(3);
      expect(b.displayId, b.name).not.toBeNull();
      expect(b.npcIds.length, b.name).toBeGreaterThan(0);
    }
  });

  it("recognises every dungeon boss and writes up at least one ability for nearly all of them", () => {
    const dungeonBosses = BOSSES.filter((b) => DUNGEONS.some((d) => d.id === b.instance));
    for (const b of dungeonBosses) {
      expect(b.unitNames.length, b.name).toBeGreaterThan(0);
      expect(b.abilities.length, b.name).toBe(b.status === "scaffold" ? 0 : b.abilities.length);
      if (b.status === "partial") expect(b.abilities.length, b.name).toBeLessThanOrEqual(2);
      if (b.status === "full") expect(b.abilities.length, b.name).toBeGreaterThanOrEqual(b.rare ? 0 : 2);
      if (b.encounterId === null) expect(b.rare, b.name).toBe(true);
    }
    const scaffolds = dungeonBosses.filter((b) => b.status === "scaffold").map((b) => b.key);
    expect(scaffolds.length).toBeLessThanOrEqual(4);
    const priority = dungeonBosses.filter((b) => PRIORITY.includes(b.instance));
    expect(priority.filter((b) => b.status === "full").length / priority.length).toBeGreaterThan(0.6);
    // A boss without a researched NPC ID or spells says so.
    for (const b of dungeonBosses.filter((x) => x.npcIds.length === 0)) expect(b.uncertain, b.name).toBeTruthy();
  });

  it("uses spell IDs whose client names match the ability, each with an icon or an explicit fallback", () => {
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

  it("points portraits at a creature display or the fallback", () => {
    for (const b of BOSSES) {
      if (b.displayId !== null) expect(Number.isInteger(b.displayId) && b.displayId > 0, b.name).toBe(true);
    }
    const withArt = BOSSES.filter((b) => b.displayId !== null).length;
    expect(withArt / BOSSES.length).toBeGreaterThan(0.85);
  });

  it("keeps descriptions short and in house style", () => {
    const style = (text: string, where: string) => {
      expect(text.length, where).toBeLessThan(160);
      expect(text, where).not.toMatch(/\u00b7/);
      expect(text, where).not.toMatch(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u);
    };
    for (const b of BOSSES) {
      style(b.summary, b.name);
      style(b.uncertain ?? "", b.name);
      for (const a of b.abilities) for (const text of [a.summary, a.counter, a.uncertain ?? ""]) style(text, `${b.name}: ${a.name}`);
    }
  });
});

describe("the Stockade", () => {
  const stockade = BOSSES.filter((b) => b.instance === "stockade");

  it("writes up every boss in full, including the rare Bruegal Ironknuckle", () => {
    expect(stockade.map((b) => b.name)).toEqual(["Targorr the Dread", "Kam Deepfury", "Hamhock", "Dextren Ward", "Bazil Thredd", "Bruegal Ironknuckle"]);
    expect(stockade.every((b) => b.status === "full" && b.displayId !== null)).toBe(true);
    for (const b of stockade.filter((x) => !x.rare)) expect(b.abilities.length, b.name).toBeGreaterThanOrEqual(2);
  });

  it("recognises Bruegal by unit only, since he has no DungeonEncounter row", () => {
    const bruegal = bossForUnit(1720, "Bruegal Ironknuckle")!;
    expect(bruegal).toMatchObject({ key: "bruegal-ironknuckle", rare: true, encounterId: null, abilities: [] });
    expect(bossForUnit(null, "Bruegal Ironknuckle")).toBe(bruegal);
    expect(bossForEncounter(2760)?.key).toBe("bazil-thredd");
    expect(bossForUnit(1706, "Defias Prisoner")).toBeNull();
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

  it("recognises dungeon bosses by encounter (both Blackfathom Deeps sets), NPC ID and name", () => {
    expect(bossForEncounter(2747)?.key).toBe("edwin-vancleef");
    expect(bossForEncounter(2767)?.key).toBe("akumai");
    expect(bossForEncounter(2910)?.key).toBe("akumai");
    expect(bossForUnit(639, "Edwin VanCleef")?.instance).toBe("deadmines");
    expect(bossForUnit(10440, "Unknown")?.key).toBe("baron-rivendare");
    expect(bossForUnit(null, "Ras Frostwhisper")?.key).toBe("ras-frostwhisper");
    expect(bossForUnit(null, "Ras Frostwhisperer")?.key).toBe("ras-frostwhisper");
    expect(bossForUnit(null, "Doom'rel")?.key).toBe("the-seven");
    expect(bossForUnit(10813, "Balnazzar")?.key).toBe("balnazzar");
    expect(bossForUnit(10812, "Grand Crusader Dathrohan")?.key).toBe("balnazzar");
    expect(bossForUnit(598, "Defias Miner")).toBeNull();
    expect(bossAmong([{ npcId: 636, name: "Defias Blackguard" }, { npcId: 639, name: "Edwin VanCleef" }])?.key).toBe("edwin-vancleef");
    expect(bossAmong([{ npcId: 598, name: "Defias Miner" }])).toBeNull();
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

  it("searches bosses, instances and abilities, ignoring apostrophes and case", () => {
    const keys = (q: string) => searchBosses(q).flatMap((g) => g.bosses.map((b) => b.key));
    expect(keys("rhahkzor")).toEqual(["rhahkzor"]);
    expect(keys("VANCLEEF")).toEqual(["edwin-vancleef"]);
    expect(keys("brd emperor")).toEqual(["emperor-dagran-thaurissan"]);
    expect(searchBosses("dire maul").map((g) => g.instance.id)).toEqual(["dm-east", "dm-west", "dm-north"]);
    expect(keys("smite stomp")).toEqual(["mr-smite"]);
    expect(searchBosses("   ")).toEqual([]);
    expect(searchBosses("no such boss")).toEqual([]);
  });
});
