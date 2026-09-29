import { describe, expect, it } from "vitest";
import { addonStatus } from "../src/core/addon-status";

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
