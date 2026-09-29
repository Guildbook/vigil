import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Callout, CompletedFight } from "@/lib/vigil/live";
import { analyzeText } from "@/lib/vigil/analyze";
import { PALADIN, paladinLog, WARRIOR, warriorLog } from "./support/combatlog";
import { CompanionEngine, LogClock } from "../src/core/engine";
import { LogTailer, type FileChangeReason } from "../src/core/tailer";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "vigil-tail-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tailer(opts: { startAt?: "end" | "start" } = {}) {
  const lines: string[] = [];
  const changes: [string | null, FileChangeReason][] = [];
  const t = new LogTailer(
    { dir, startAt: opts.startAt ?? "start" },
    { onLines: (l) => lines.push(...l), onFileChange: (f, r) => changes.push([f, r]) },
  );
  return { t, lines, changes };
}

/** An engine on a fake wall clock, collecting finished fights and callouts. */
function engine(startAt: "end" | "start" = "start") {
  let wall = 1_000_000;
  const fights: CompletedFight[] = [];
  const callouts: Callout[] = [];
  const e = new CompanionEngine({
    logsDir: dir,
    startAt,
    wall: () => wall,
    session: { fallbackYear: 2026 },
    onFight: (f) => fights.push(f),
    onCallout: (c) => callouts.push(c),
  });
  return { e, fights, callouts, advance: (ms: number) => (wall += ms) };
}

/** Cuts text into uneven chunks that split lines (and sometimes land exactly on a newline). */
function chunks(text: string, n: number): string[] {
  const out: string[] = [];
  let seed = 11;
  for (let i = 0; i < text.length; ) {
    seed = (seed * 48271) % 2147483647;
    const size = 1 + (seed % n);
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

describe("LogTailer", () => {
  it("holds a partial line until the client finishes writing it", async () => {
    const file = path.join(dir, "WoWCombatLog.txt");
    const [header, first] = [...warriorLog().split("\n")];
    writeFileSync(file, `${header}\n`);
    const { t, lines, changes } = tailer();
    await t.poll();
    expect(changes).toEqual([["WoWCombatLog.txt", "initial"]]);
    expect(lines).toEqual([header]);

    appendFileSync(file, first!.slice(0, 40));
    await t.poll();
    expect(lines).toHaveLength(1);
    expect(t.pendingText).toBe(first!.slice(0, 40));

    appendFileSync(file, `${first!.slice(40)}\n`);
    await t.poll();
    expect(lines).toEqual([header, first]);
    expect(t.pendingText).toBe("");
  });

  it("starts at the end of an existing log by default, so old sessions are not replayed", async () => {
    const file = path.join(dir, "WoWCombatLog.txt");
    writeFileSync(file, paladinLog());
    const { t, lines } = tailer({ startAt: "end" });
    await t.poll();
    expect(lines).toEqual([]);
    appendFileSync(file, "9/27/2026 21:00:00.000-4  COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1\n");
    await t.poll();
    expect(lines).toHaveLength(1);
  });

  it("reads a log that appears after it started watching from the beginning", async () => {
    const { t, lines, changes } = tailer({ startAt: "end" });
    await t.poll();
    expect(changes).toEqual([]);
    writeFileSync(path.join(dir, "WoWCombatLog.txt"), "header\nfirst\n");
    await t.poll();
    expect(changes).toEqual([["WoWCombatLog.txt", "new-session"]]);
    expect(lines).toEqual(["header", "first"]);
  });

  it("follows a new session file, a truncation and a file replaced under the same name", async () => {
    const first = path.join(dir, "WoWCombatLog-092726_210000.txt");
    writeFileSync(first, "a\nb\n");
    const { t, lines, changes } = tailer();
    await t.poll();

    await sleep(20);
    const second = path.join(dir, "WoWCombatLog-092726_220000.txt");
    appendFileSync(first, "c\n");
    writeFileSync(second, "d\n");
    await t.poll();
    expect(lines).toEqual(["a", "b", "c", "d"]);
    expect(changes.at(-1)).toEqual(["WoWCombatLog-092726_220000.txt", "new-session"]);

    truncateSync(second, 0);
    appendFileSync(second, "e\n");
    await t.poll();
    expect(changes.at(-1)).toEqual(["WoWCombatLog-092726_220000.txt", "truncated"]);
    expect(lines.at(-1)).toBe("e");

    await sleep(20);
    renameSync(second, path.join(dir, "old.txt"));
    writeFileSync(second, "f\ng\n");
    await t.poll();
    expect(changes.at(-1)![1]).toMatch(/replaced|new-session/);
    expect(lines.slice(-2)).toEqual(["f", "g"]);

    rmSync(second);
    rmSync(first);
    await t.poll();
    expect(changes.at(-1)).toEqual([null, "gone"]);
  });
});

describe("CompanionEngine on a growing log", () => {
  it("builds live metrics mid-fight and the same fights as the batch upload from chunked appends", async () => {
    const file = path.join(dir, "WoWCombatLog.txt");
    writeFileSync(file, "");
    const { e, fights, callouts, advance } = engine();
    await e.poll();

    const text = warriorLog();
    const pieces = chunks(text, 900);
    let sawLive = false;
    for (const piece of pieces) {
      appendFileSync(file, piece);
      await e.poll();
      advance(50);
      const snap = e.tick();
      if (snap.current && snap.current.label === "Defias Pillager" && snap.current.elapsedMs > 8000 && !sawLive) {
        sawLive = true;
        expect(snap.player).toMatchObject({ name: "Rhune", guid: WARRIOR.guid });
        expect(snap.model?.id).toBe("warrior-protection");
        expect(snap.log).toMatchObject({ version: 22, advanced: true });
        expect(snap.current.score).toBeGreaterThan(0);
        expect(snap.current.gcdUsage).toBeGreaterThan(0.3);
        expect(snap.current.uptimes.map((u) => u.key)).toEqual(expect.arrayContaining(["shield-block", "sunder"]));
      }
    }
    expect(sawLive).toBe(true);
    // The boss ends with ENCOUNTER_END; nothing further is needed to finish it.
    expect(fights.map((f) => f.report.fight.label)).toEqual(["Defias Pillager", "Rhahk'Zor"]);

    const batch = analyzeText(text, WARRIOR.guid, "warrior-protection", "Rhune");
    expect(fights.map((f) => f.report.fight)).toEqual(batch.map((r) => r.fight));
    expect(callouts.some((c) => c.kind === "proc" && c.text.startsWith("Revenge was available for"))).toBe(true);
  });

  it("closes a trash fight when the log goes quiet, by the wall clock", async () => {
    const file = path.join(dir, "WoWCombatLog.txt");
    const text = paladinLog();
    const cut = text.indexOf("\n", text.indexOf("UNIT_DIED")) + 1;
    writeFileSync(file, text.slice(0, cut));
    const { e, fights, advance } = engine();
    await e.poll();
    advance(1000);
    const live = e.tick();
    expect(live.current).toMatchObject({ label: "Rockhide Boar" });
    expect(live.current!.idleNowMs).toBeGreaterThan(0);
    expect(fights).toEqual([]);

    advance(7000);
    expect(e.tick().current).toBeNull();
    expect(fights.map((f) => f.report.fight.label)).toEqual(["Rockhide Boar"]);
  });

  it("handles a buffered burst, then a new /combatlog session file for another character", async () => {
    writeFileSync(path.join(dir, "WoWCombatLog-092726_210000.txt"), warriorLog());
    const { e, fights } = engine();
    await e.poll();
    expect(e.tick().player?.name).toBe("Rhune");
    expect(fights.map((f) => f.report.fight.label)).toEqual(["Defias Pillager", "Rhahk'Zor"]);

    await sleep(20);
    writeFileSync(path.join(dir, "WoWCombatLog-092826_120000.txt"), paladinLog());
    await e.poll();
    const snap = e.tick();
    expect(snap.status.lastChange).toBe("new-session");
    expect(snap.status.file).toMatch(/092826_120000/);
    expect(snap.player).toMatchObject({ guid: PALADIN.guid, name: "Tor" });
    expect(snap.model?.id).toBe("paladin-leveling");
    e.stop();
    expect(fights.map((f) => f.report.fight.label)).toEqual(["Defias Pillager", "Rhahk'Zor", "Rockhide Boar", "Young Wolf"]);
  });

  it("reports how long the log has sat unchanged, reset by each write the client flushes", async () => {
    const file = path.join(dir, "WoWCombatLog.txt");
    const { e, advance } = engine();
    await e.poll();
    expect(e.tick().status.quietMs).toBeNull();

    writeFileSync(file, "9/28/2026 19:52:18.598-7  COMBAT_LOG_VERSION,9,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,2.5.6,PROJECT_ID,5\n");
    await e.poll();
    advance(150_000);
    expect(e.tick().status.quietMs).toBe(150_000);

    appendFileSync(file, '9/28/2026 19:55:29.007-7  ZONE_CHANGE,389,"Ragefire Chasm",1\n');
    await e.poll();
    advance(1000);
    expect(e.tick().status.quietMs).toBe(1000);
  });

  it("recovers from truncation mid-session", async () => {
    const file = path.join(dir, "WoWCombatLog.txt");
    writeFileSync(file, warriorLog().slice(0, 5000));
    const { e, fights } = engine();
    await e.poll();
    truncateSync(file, 0);
    appendFileSync(file, paladinLog());
    await e.poll();
    const snap = e.tick();
    expect(snap.status.lastChange).toBe("truncated");
    expect(snap.player?.name).toBe("Tor");
    e.stop();
    // The warrior pull that was open when the file was cut is closed as it stood.
    expect(fights.map((f) => f.report.fight.label)).toEqual(["Defias Pillager", "Rockhide Boar", "Young Wolf"]);
    expect(fights[0]!.report.fight.durationMs).toBeLessThan(24_000);
  });
});

describe("LogClock", () => {
  it("runs on from the last event by wall time, capped at fifteen minutes", () => {
    let wall = 0;
    const clock = new LogClock(() => wall);
    expect(clock.now()).toBeNull();
    clock.seen(5000);
    wall = 2000;
    expect(clock.now()).toBe(7000);
    wall = 60 * 60_000;
    expect(clock.now()).toBe(5000 + 15 * 60_000);
  });
});
