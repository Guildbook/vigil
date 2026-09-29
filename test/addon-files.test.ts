import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import luaparse from "luaparse";
import { describe, expect, it } from "vitest";
import { readTocVersion } from "../src/core/addon";

const dir = path.resolve(__dirname, "..", "resources", "addon", "Vigil");
const tocText = readFileSync(path.join(dir, "Vigil.toc"), "utf8");
const luaText = readFileSync(path.join(dir, "Vigil.lua"), "utf8");

function tocField(name: string): string | null {
  const m = tocText.match(new RegExp(`^##\\s*${name}:\\s*([^\\r\\n]+)`, "m"));
  return m ? m[1]!.trim() : null;
}

type Node = { type: string; [key: string]: unknown };

function walk(node: unknown, visit: (n: Node) => void) {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
  } else if (node && typeof node === "object" && typeof (node as Node).type === "string") {
    visit(node as Node);
    for (const value of Object.values(node)) walk(value, visit);
  }
}

const ast = luaparse.parse(luaText, { luaVersion: "5.1", scope: true, locations: true });

/** Names the file assigns or declares as globals. */
function globalWrites(): string[] {
  const names = new Set<string>();
  walk(ast, (n) => {
    if (n.type === "AssignmentStatement") {
      for (const target of n.variables as Node[]) {
        if (target.type === "Identifier" && !target.isLocal) names.add(target.name as string);
      }
    }
    if (n.type === "FunctionDeclaration" && !n.isLocal) {
      const id = n.identifier as Node | null;
      if (id?.type === "Identifier") names.add(id.name as string);
    }
  });
  return [...names].sort();
}

describe("bundled Vigil addon files", () => {
  it("is valid Lua 5.1 and only writes the globals the client and TOC expect", () => {
    expect(ast.type).toBe("Chunk");
    expect(globalWrites()).toEqual([
      "SLASH_VIGIL1",
      "VigilDB",
      "Vigil_OnAddonCompartmentClick",
      "Vigil_OnAddonCompartmentEnter",
      "Vigil_OnAddonCompartmentLeave",
    ]);
  });

  it("loads on Classic Era, the Classic beta (Forever) and TBC Anniversary", () => {
    const interfaces = (tocField("Interface") ?? "").split(",").map((s) => s.trim());
    for (const n of interfaces) expect(n).toMatch(/^\d{5,6}$/);
    expect(interfaces).toEqual(expect.arrayContaining(["11507", "16001", "20505", "20506"]));
  });

  it("declares its SavedVariables, metadata and files", () => {
    expect(tocField("Title")).toBe("Vigil");
    expect(tocField("SavedVariables")).toBe("VigilDB");
    expect(tocField("Version")).toMatch(/^\d+\.\d+\.\d+$/);
    const files = tocText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(files).toEqual(["Vigil.lua"]);
    for (const f of files) expect(existsSync(path.join(dir, f))).toBe(true);
  });

  it("points the addon compartment at functions the Lua defines", () => {
    for (const field of ["AddonCompartmentFunc", "AddonCompartmentFuncOnEnter", "AddonCompartmentFuncOnLeave"]) {
      const name = tocField(field);
      expect(name, field).toMatch(/^Vigil_\w+$/);
      expect(luaText).toMatch(new RegExp(`^function ${name}\\(`, "m"));
    }
  });

  it("uses one version in the TOC, the Lua and the README example", () => {
    const version = readTocVersion(path.join(dir, "Vigil.toc"));
    expect(luaText.match(/^local ADDON_VERSION = "([^"]+)"/m)?.[1]).toBe(version);
    const readme = readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme.match(/"addonVersion":"([^"]+)"/)?.[1]).toBe(version);
  });

  it("has no middots or emoji in the addon", () => {
    for (const text of [tocText, luaText]) {
      expect(text.includes(String.fromCharCode(0xb7))).toBe(false);
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
    }
  });
});
