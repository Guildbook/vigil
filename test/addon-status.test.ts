import { describe, expect, it } from "vitest";
import { addonPrompt, addonStatus } from "../src/core/addon-status";

describe("addonStatus", () => {
  it("offers an install when the addon is missing", () => {
    expect(addonStatus(null, "0.2.0")).toEqual({ text: "Not installed", action: "install" });
    expect(addonStatus(null, null)).toEqual({ text: "Not installed", action: null });
  });

  it("offers an update when the bundled addon is newer", () => {
    expect(addonStatus("0.1.0", "0.2.0")).toEqual({ text: "v0.1.0 installed, v0.2.0 available", action: "update" });
    expect(addonStatus("0.9.0", "0.10.0").action).toBe("update");
  });

  it("says up to date when the versions match", () => {
    expect(addonStatus("0.1.1", "0.1.1")).toEqual({ text: "v0.1.1, up to date", action: "reinstall" });
  });

  it("never offers to replace a newer install with the bundled copy", () => {
    expect(addonStatus("0.3.0", "0.2.0")).toEqual({ text: "v0.3.0 installed, newer than the bundled v0.2.0", action: null });
    expect(addonStatus("0.1.0", null)).toEqual({ text: "v0.1.0 installed", action: null });
  });
});

describe("addonPrompt", () => {
  const era = { label: "Classic Era (_classic_era_)", clientDir: "/Applications/World of Warcraft/_classic_era_", installed: null };
  const forever = { label: "WoW: Forever (_forever_)", clientDir: "/Applications/World of Warcraft/_forever_", installed: null };

  it("asks to install for the client whose log is followed", () => {
    const p = addonPrompt([era, forever], "0.2.0", "/Applications/World of Warcraft/_forever_/Logs", []);
    expect(p).toMatchObject({ clientDir: forever.clientDir, action: "install", dismissKey: `${forever.clientDir}@0.2.0` });
  });

  it("falls back to the best-guess client when no log is followed", () => {
    expect(addonPrompt([era, forever], "0.2.0", null, [])?.clientDir).toBe(era.clientDir);
  });

  it("matches Windows paths whatever their case", () => {
    const win = { label: "Classic Era", clientDir: "C:\\Program Files (x86)\\World of Warcraft\\_classic_era_", installed: null };
    const other = { label: "Retail", clientDir: "C:\\Program Files (x86)\\World of Warcraft\\_retail_", installed: null };
    expect(addonPrompt([other, win], "0.2.0", "c:\\program files (x86)\\world of warcraft\\_classic_era_\\Logs", [])?.clientDir).toBe(win.clientDir);
  });

  it("asks to update an older install and stays quiet when it is current or newer", () => {
    expect(addonPrompt([{ ...era, installed: "0.1.0" }], "0.2.0", null, [])).toMatchObject({ action: "update", installed: "0.1.0" });
    expect(addonPrompt([{ ...era, installed: "0.2.0" }], "0.2.0", null, [])).toBeNull();
    expect(addonPrompt([{ ...era, installed: "0.3.0" }], "0.2.0", null, [])).toBeNull();
  });

  it("stays quiet after Not now until a newer addon is bundled", () => {
    const dismissed = [`${era.clientDir}@0.2.0`];
    expect(addonPrompt([era], "0.2.0", null, dismissed)).toBeNull();
    expect(addonPrompt([era], "0.3.0", null, dismissed)?.action).toBe("install");
  });

  it("says nothing without a bundled addon or a WoW install", () => {
    expect(addonPrompt([era], null, null, [])).toBeNull();
    expect(addonPrompt([], "0.2.0", null, [])).toBeNull();
  });
});
