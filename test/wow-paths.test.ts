import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addonDestDir, compareSemver, installAddon, installedVersion, pickAddonSource } from "../src/core/addon";
import { discoverLogsCandidates, resolveLogsDir, wowRootCandidates } from "../src/core/wow-paths";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "vigil-wow-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function client(root: string, flavor: string, log?: { name: string; ageS: number }) {
  const dir = path.join(root, flavor);
  mkdirSync(path.join(dir, "Logs"), { recursive: true });
  if (log) {
    const file = path.join(dir, "Logs", log.name);
    writeFileSync(file, "x\n");
    const t = Date.now() / 1000 - log.ageS;
    utimesSync(file, t, t);
  }
  return dir;
}

describe("Logs folder discovery", () => {
  it("lists the usual install roots per platform", () => {
    expect(wowRootCandidates("darwin", "/Users/me")).toContain("/Applications/World of Warcraft");
    expect(wowRootCandidates("win32", "C:\\Users\\me")).toContain("C:\\Program Files (x86)\\World of Warcraft");
  });

  it("offers every _flavor_ folder, the one with the freshest combat log first, unknown names included", () => {
    const root = path.join(tmp, "World of Warcraft");
    client(root, "_classic_era_", { name: "WoWCombatLog.txt", ageS: 3600 });
    client(root, "_wow_forever_beta_", { name: "WoWCombatLog-092826_190000.txt", ageS: 10 });
    client(root, "_retail_");
    mkdirSync(path.join(root, "Data"));
    const found = discoverLogsCandidates([root, path.join(tmp, "missing")]);
    expect(found.map((c) => c.flavor)).toEqual(["_wow_forever_beta_", "_classic_era_", "_retail_"]);
    expect(found[0]).toMatchObject({ label: "WoW: Forever", hasLogsDir: true, latestLog: { name: "WoWCombatLog-092826_190000.txt" } });
    expect(resolveLogsDir(null, found)).toBe(path.join(root, "_wow_forever_beta_", "Logs"));
  });

  it("ranks the Classic beta above Era when neither has logged yet, and labels unknown folders readably", () => {
    const root = path.join(tmp, "WoW");
    client(root, "_classic_era_");
    client(root, "_classic_beta_");
    client(root, "_something_new_");
    const found = discoverLogsCandidates([root]);
    expect(found.map((c) => c.label)).toEqual(["Classic beta (possibly Forever beta)", "Classic Era", "something new"]);
  });

  it("accepts an override pointing at the Logs folder, a client folder or the WoW root", () => {
    const root = path.join(tmp, "World of Warcraft");
    const beta = client(root, "_classic_beta_", { name: "WoWCombatLog.txt", ageS: 5 });
    expect(resolveLogsDir(path.join(beta, "Logs"), [])).toBe(path.join(beta, "Logs"));
    expect(resolveLogsDir(beta, [])).toBe(path.join(beta, "Logs"));
    expect(resolveLogsDir(root, [])).toBe(path.join(beta, "Logs"));
  });
});

describe("Vigil addon install", () => {
  it("copies the newest source into Interface/AddOns/Vigil and reports the installed version", () => {
    const stale = path.join(tmp, "resources", "addon", "Vigil");
    const fresh = path.join(tmp, "addons", "Vigil");
    for (const [dir, v] of [[stale, "0.1.0"], [fresh, "0.2.0"]] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "Vigil.toc"), `## Interface: 11507\n## Version: ${v}\n`);
      writeFileSync(path.join(dir, "Vigil.lua"), "-- vigil\n");
    }
    const picked = pickAddonSource([stale, fresh, path.join(tmp, "nope")]);
    expect(picked).toEqual({ path: fresh, version: "0.2.0" });
    expect(compareSemver("0.10.0", "0.9.9")).toBeGreaterThan(0);

    const clientDir = path.join(tmp, "World of Warcraft", "_classic_beta_");
    mkdirSync(clientDir, { recursive: true });
    expect(installedVersion(clientDir)).toBeNull();
    mkdirSync(addonDestDir(clientDir), { recursive: true });
    expect(installedVersion(clientDir)).toBeNull();
    writeFileSync(path.join(addonDestDir(clientDir), "Leftover.lua"), "old");

    expect(installAddon(picked!.path, clientDir)).toMatchObject({ version: "0.2.0" });
    expect(installedVersion(clientDir)).toBe("0.2.0");
    expect(() => installAddon(picked!.path, path.join(tmp, "missing"))).toThrow("does not exist");
  });
});
