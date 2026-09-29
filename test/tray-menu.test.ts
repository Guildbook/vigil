import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EngineSnapshot } from "../src/core/engine";
import type { AppState, FightSummary, UploadState } from "../src/core/protocol";
import { trayMenu, trayStatus } from "../src/core/tray-menu";

const LOGS = "/Applications/World of Warcraft/_classic_era_/Logs";

/** Only the status matters to the tray. */
function engine(status: Partial<EngineSnapshot["status"]> = {}): EngineSnapshot {
  return { status: { logsDir: LOGS, file: `${LOGS}/WoWCombatLog.txt`, lastChange: "initial", lines: 10, error: null, ...status } } as EngineSnapshot;
}

const fight = (id: string, upload: UploadState) => ({ id, upload }) as FightSummary;

type State = Parameters<typeof trayStatus>[0];

function state(overrides: Partial<State> = {}): State {
  return {
    logsDir: LOGS,
    logsOptions: [{ label: "Classic Era (_classic_era_)", logsDir: LOGS, latestLog: "WoWCombatLog.txt", latestAt: 1 }],
    engine: engine(),
    pairing: { paired: true, guild: { slug: "osm", name: "Order of Saint Michael" }, user: null, device: null, defaultVisibility: null, storage: "keychain", error: null },
    fights: [],
    server: { homeUrl: "https://guildbook.io", siteUrl: "https://osm.guildbook.io", dev: false },
    update: { state: "idle" },
    uploadsPaused: false,
    ...overrides,
  } satisfies Partial<AppState>;
}

const unpaired = { paired: false, guild: null, user: null, device: null, defaultVisibility: null, storage: null, error: null };

describe("trayStatus", () => {
  it("names the client being watched and the paired guild", () => {
    const s = trayStatus(state());
    expect(s).toMatchObject({ status: "Watching Classic Era log", guild: "Paired with Order of Saint Michael", uploads: null, tone: "ok" });
    expect(s.tooltip).toBe("Vigil\nWatching Classic Era log\nPaired with Order of Saint Michael");
  });

  it("falls back to a generic line for a folder chosen outside the detected clients", () => {
    expect(trayStatus(state({ logsOptions: [] })).status).toBe("Watching the combat log");
  });

  it("flags log problems for attention", () => {
    expect(trayStatus(state({ logsDir: null, engine: null }))).toMatchObject({ status: "No Logs folder found", tone: "attention" });
    expect(trayStatus(state({ engine: null }))).toMatchObject({ status: "Logs folder is missing", tone: "attention" });
    expect(trayStatus(state({ engine: engine({ error: "EACCES" }) }))).toMatchObject({ status: "Can't read the combat log", tone: "attention" });
    expect(trayStatus(state({ engine: engine({ file: null }) }))).toMatchObject({ status: "Waiting for a combat log", tone: "ok" });
  });

  it("counts fights still to upload, including ones waiting to retry", () => {
    const fights = [
      fight("a", { state: "uploading" }),
      fight("b", { state: "queued" }),
      fight("c", { state: "failed", error: "503", retrying: true }),
      fight("d", { state: "failed", error: "400", retrying: false }),
      fight("e", { state: "uploaded", url: "u" }),
      fight("f", { state: "skipped", reason: "short" }),
    ];
    expect(trayStatus(state({ fights })).uploads).toBe("Uploading 3 fights");
    expect(trayStatus(state({ fights: fights.slice(0, 1) })).uploads).toBe("Uploading 1 fight");
  });

  it("shows pause and what is waiting behind it", () => {
    expect(trayStatus(state({ uploadsPaused: true }))).toMatchObject({ uploads: "Uploads paused", tone: "paused" });
    expect(trayStatus(state({ uploadsPaused: true, fights: [fight("a", { state: "queued" }), fight("b", { state: "queued" })] })).uploads).toBe(
      "Uploads paused, 2 fights waiting",
    );
  });

  it("says when unpaired without raising an alarm, and surfaces site errors", () => {
    expect(trayStatus(state({ pairing: unpaired }))).toMatchObject({ guild: "Not paired with a guild", uploads: null, tone: "ok" });
    const error = "The site refused this companion: the device was revoked by an officer of the guild.";
    const s = trayStatus(state({ pairing: { ...state().pairing, error } }));
    expect(s.tone).toBe("attention");
    expect(s.uploads!.length).toBeLessThanOrEqual(60);
    expect(s.uploads!.endsWith("...")).toBe(true);
  });
});

describe("trayMenu", () => {
  const labels = (s: State) => trayMenu(s).map((i) => (i.type === "separator" ? "-" : i.label));

  it("lists status, guild and actions for a paired, watching companion", () => {
    expect(labels(state())).toEqual([
      "Watching Classic Era log",
      "Paired with Order of Saint Michael",
      "-",
      "Open Vigil",
      "Pause uploads",
      "Open Logs folder",
      "Open guild site",
      "-",
      "Check for updates...",
      "Quit Vigil",
    ]);
  });

  it("offers resume while paused and a restart once an update is ready", () => {
    const l = labels(state({ uploadsPaused: true, update: { state: "ready", version: "0.2.0" } }));
    expect(l).toContain("Resume uploads");
    expect(l).not.toContain("Pause uploads");
    expect(l).toContain("Restart to update to Vigil 0.2.0");
    expect(l).not.toContain("Check for updates...");
  });

  it("hides pausing and disables links that have nowhere to go", () => {
    const items = trayMenu(state({ pairing: unpaired, logsDir: null, engine: null }));
    expect(items.some((i) => i.type === "action" && (i.action === "pause" || i.action === "resume"))).toBe(false);
    const enabled = (action: string) => items.find((i) => i.type === "action" && i.action === action);
    expect(enabled("open-logs")).toMatchObject({ enabled: false });
    expect(enabled("open-site")).toMatchObject({ enabled: false });
  });

  it("uses no middots or emoji in any line", () => {
    const all = [state(), state({ uploadsPaused: true, fights: [fight("a", { state: "queued" })] }), state({ pairing: unpaired, logsDir: null, engine: null })]
      .flatMap(labels)
      .join("\n");
    expect(all).not.toMatch(/[\u00b7\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe("tray icons", () => {
  const dir = path.resolve(__dirname, "..", "resources", "tray");
  const pngSize = (file: string) => {
    const data = readFileSync(path.join(dir, file));
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  };

  it("has every tone for every platform, at the sizes each tray expects", () => {
    for (const suffix of ["", "-attention", "-paused"]) {
      expect(pngSize(`tray${suffix}Template.png`)).toEqual([18, 18]);
      expect(pngSize(`tray${suffix}Template@2x.png`)).toEqual([36, 36]);
      expect(pngSize(`tray${suffix}.png`)).toEqual([24, 24]);
      const ico = readFileSync(path.join(dir, `tray${suffix}.ico`));
      const count = ico.readUInt16LE(4);
      expect(Array.from({ length: count }, (_, i) => ico.readUInt8(6 + 16 * i))).toEqual([16, 20, 24, 32]);
    }
  });
});
