import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import luaparse from "luaparse";
import { describe, expect, it } from "vitest";
import { ADDON_DATA_DIR, renderAddonData } from "../scripts/addon-data";
import { BOSSES } from "../src/data/bosses";

describe("generated addon data (pnpm addon:data)", () => {
  const files = renderAddonData();

  it("is up to date with src/data", () => {
    expect(readdirSync(ADDON_DATA_DIR).sort()).toEqual(Object.keys(files).sort());
    for (const [name, text] of Object.entries(files)) {
      // Windows checkouts get CRLF line endings.
      const onDisk = readFileSync(path.join(ADDON_DATA_DIR, name), "utf8").replace(/\r\n/g, "\n");
      expect(onDisk, `${name} is stale: run pnpm addon:data`).toBe(text);
    }
  });

  it("is valid Lua 5.1 that only fills the addon's private table", () => {
    for (const text of Object.values(files)) {
      expect(() => luaparse.parse(text, { luaVersion: "5.1" })).not.toThrow();
      expect(text).toMatch(/^local _, ns = \.\.\.$/m);
    }
  });

  it("carries every boss with its NPC IDs and abilities", () => {
    const text = files["Bosses.lua"]!;
    expect(text.match(/^ {2}\{ k = /gm)?.length).toBe(BOSSES.length);
    const lucifron = BOSSES.find((b) => b.key === "lucifron")!;
    expect(text).toContain(`{ k = "lucifron", n = "Lucifron", i = "mc", e = { 663 }, ids = { ${lucifron.npcIds.join(", ")} }`);
    expect(text).toContain('n = "Impending Doom", id = { 19702 }');
  });
});
