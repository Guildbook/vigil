import { describe, expect, it } from "vitest";
import { buildIconData, iconFromMedia, iconName, parseCsv } from "../scripts/icon-data";

describe("icon data generation", () => {
  it("parses wago.tools CSV exports, quotes and all", () => {
    const rows = parseCsv('ID,Name_lang,Note\n1,"Gehennas\' Curse","say ""hi"", then\nleave"\r\n2,Plain,\n');
    expect(rows).toEqual([
      { ID: "1", Name_lang: "Gehennas' Curse", Note: 'say "hi", then\nleave' },
      { ID: "2", Name_lang: "Plain", Note: "" },
    ]);
  });

  it("turns client icon file names into render CDN names", () => {
    expect(iconName("Ability_Warrior_Sunder.blp")).toBe("ability_warrior_sunder");
    expect(iconName("ability_druid_mangle.tga.blp")).toBe("ability_druid_mangle");
    expect(iconName("../etc/passwd")).toBeNull();
  });

  it("maps spell IDs and class spell names to icons, and class spells to classes", () => {
    const data = buildIconData(
      {
        manifest: [
          { ID: "100", FilePath: "Interface\\Icons\\", FileName: "Ability_Warrior_Sunder.blp" },
          { ID: "101", FilePath: "Interface\\ICONS\\", FileName: "Spell_Fire_SoulBurn.blp" },
          { ID: "102", FilePath: "Interface\\Icons\\", FileName: "Temp.blp" },
          { ID: "103", FilePath: "Interface\\AbilitiesFrame\\", FileName: "Frame.blp" },
        ],
        spellMisc: [
          { SpellID: "7386", DifficultyID: "0", SpellIconFileDataID: "100" },
          { SpellID: "11597", DifficultyID: "0", SpellIconFileDataID: "100" },
          { SpellID: "20566", DifficultyID: "0", SpellIconFileDataID: "101" },
          { SpellID: "20566", DifficultyID: "1", SpellIconFileDataID: "100" },
          { SpellID: "3354", DifficultyID: "0", SpellIconFileDataID: "102" },
          { SpellID: "9", DifficultyID: "0", SpellIconFileDataID: "103" },
        ],
        spellNames: [
          { ID: "7386", Name_lang: "Sunder Armor" },
          { ID: "11597", Name_lang: "Sunder Armor" },
          { ID: "20566", Name_lang: "Wrath of Ragnaros" },
        ],
        classOptions: [
          { SpellID: "11597", SpellClassSet: "4" },
          { SpellID: "7386", SpellClassSet: "4" },
          { SpellID: "20566", SpellClassSet: "0" },
        ],
      },
      { source: "test", build: "1.15.9" },
    );
    expect(data.icons).toEqual(["ability_warrior_sunder", "spell_fire_soulburn"]);
    expect(data.spells).toEqual({ 7386: 0, 11597: 0, 20566: 1 });
    expect(data.names).toEqual({ "sunder armor": 0 });
    expect(data.classes.warrior).toEqual([7386, 11597]);
    expect(data.classes.mage).toEqual([]);
  });

  it("reads the icon from a Game Data API spell media document", () => {
    expect(
      iconFromMedia({ assets: [{ key: "icon", value: "https://render.worldofwarcraft.com/us/icons/56/ability_warrior_sunder.jpg" }] }),
    ).toBe("ability_warrior_sunder");
    expect(iconFromMedia({ assets: [] })).toBeNull();
    expect(iconFromMedia(null)).toBeNull();
  });
});
