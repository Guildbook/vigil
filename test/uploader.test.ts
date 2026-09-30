import { describe, expect, it } from "vitest";
import { analyzeText } from "@/lib/vigil/analyze";
import type { UploadState } from "../src/core/protocol";
import { asBossFight, skipReason, Uploader, type UploadTarget } from "../src/core/uploader";
import { deadminesLog, PALADIN, paladinLog, stockadeLog, WARRIOR } from "./support/combatlog";

const [boar] = analyzeText(paladinLog(), PALADIN.guid, "paladin-leveling", "Tor");
const target: UploadTarget = { apiUrl: "http://site.test/", token: "osmv_abc", guild: "osm", visibility: null };

function harness(responses: Array<Response | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const statuses: [string, UploadState][] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let unauthorized: string | null = null;
  const up = new Uploader({
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    target: () => target,
    onStatus: (id, s) => statuses.push([id, s]),
    onUnauthorized: (m) => (unauthorized = m),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { up, calls, statuses, timers, flush, unauthorized: () => unauthorized };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("Uploader", () => {
  it("posts one report per request with the device token, guild and visibility choice", async () => {
    const h = harness([json(201, { id: "r1", url: "http://site.test/vigil/reports/r1" })]);
    h.up.enqueue("f1", boar!);
    await h.flush();
    expect(h.calls[0]!.url).toBe("http://site.test/api/vigil/companion/reports");
    expect(new Headers(h.calls[0]!.init.headers).get("authorization")).toBe("Bearer osmv_abc");
    expect(JSON.parse(String(h.calls[0]!.init.body))).toMatchObject({ guild: "osm", visibility: null, report: { version: 1 } });
    expect(h.statuses.map(([, s]) => s.state)).toEqual(["queued", "uploading", "uploaded"]);
  });

  it("retries network errors and 429s with backoff, honouring Retry-After", async () => {
    const h = harness([new Error("ECONNREFUSED"), json(429, { error: "slow down" }, { "retry-after": "7" }), json(201, { url: "u" })]);
    h.up.enqueue("f1", boar!);
    await h.flush();
    expect(h.statuses.at(-1)![1]).toMatchObject({ state: "failed", retrying: true });
    expect(h.timers[0]!.ms).toBe(2000);
    h.timers[0]!.fn();
    await h.flush();
    expect(h.timers[1]!.ms).toBe(7000);
    h.timers[1]!.fn();
    await h.flush();
    expect(h.statuses.at(-1)![1]).toEqual({ state: "uploaded", url: "u" });
    expect(h.up.pending).toBe(0);
  });

  it("stops on a revoked token and does not retry refused reports", async () => {
    const h = harness([json(400, { error: "bad format" }), json(401, { error: "revoked" })]);
    h.up.enqueue("f1", boar!);
    h.up.enqueue("f2", boar!);
    await h.flush();
    await h.flush();
    expect(h.statuses.filter(([id]) => id === "f1").at(-1)![1]).toEqual({
      state: "failed",
      error: "Not uploaded: the site rejected this report (bad format). Check for a Vigil update.",
      retrying: false,
      final: true,
    });
    expect(h.statuses.filter(([id]) => id === "f2").at(-1)![1]).toEqual({ state: "failed", error: "revoked", retrying: false });
    expect(h.unauthorized()).toBe("revoked");
    expect(h.timers).toEqual([]);
  });

  it("names the field when the site's schema rejects a report, without the site's reload advice", async () => {
    const h = harness([json(400, { error: "The report was not in a format Vigil understands. Reload and try again." })]);
    h.up.enqueue("f1", boar!);
    await h.flush();
    expect(h.statuses.at(-1)![1]).toMatchObject({
      error: "Not uploaded: the site rejected this report (The report was not in a format Vigil understands). Check for a Vigil update.",
      final: true,
    });
  });

  it("does not send a report the site's schema would refuse, and says which field is wrong", async () => {
    const h = harness([json(201, { url: "u" })]);
    h.up.enqueue("bad", { ...boar!, player: { ...boar!.player, level: 1951 } });
    h.up.enqueue("good", boar!);
    await h.flush();
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.statuses.filter(([id]) => id === "bad").at(-1)![1]).toEqual({
      state: "failed",
      error: "Not uploaded: this report failed the site's format check (player.level: Too big: expected number to be <=100). Check for a Vigil update.",
      retrying: false,
      final: true,
    });
    expect(h.statuses.at(-1)).toEqual(["good", { state: "uploaded", url: "u" }]);
  });

  it("holds the queue while paused and sends it on resume", async () => {
    const h = harness([json(201, { url: "u1" }), json(201, { url: "u2" })]);
    h.up.setPaused(true);
    h.up.enqueue("f1", boar!);
    h.up.enqueue("f2", boar!);
    await h.flush();
    expect(h.calls).toEqual([]);
    expect(h.up.pending).toBe(2);
    expect(h.up.isPaused).toBe(true);
    h.up.setPaused(false);
    await h.flush();
    await h.flush();
    expect(h.calls).toHaveLength(2);
    expect(h.up.pending).toBe(0);
  });
});

describe("Uploader with several paired guilds", () => {
  it("asks for each fight's target and sends it with that guild's token, reporting refusals for that pairing", async () => {
    const calls: { auth: string | null; guild: string }[] = [];
    const refused: [string, string | undefined][] = [];
    const targets: Record<string, UploadTarget> = {
      forever: { apiUrl: "http://site.test", token: "tok_order", guild: "order", visibility: null, pairingId: "dev-order" },
      anniversary: { apiUrl: "http://site.test", token: "tok_mirk", guild: "mirkwood", visibility: null, pairingId: "dev-mirkwood" },
    };
    const responses = [json(201, { url: "u1" }), json(401, { error: "revoked" })];
    const up = new Uploader({
      fetch: (async (_url: string, init: RequestInit) => {
        calls.push({ auth: new Headers(init.headers).get("authorization"), guild: JSON.parse(String(init.body)).guild });
        return responses.shift()!;
      }) as typeof fetch,
      target: (id) => targets[id.split(":")[0]!] ?? null,
      onStatus: () => {},
      onUnauthorized: (message, t) => refused.push([message, t.pairingId]),
      setTimer: () => {},
    });
    up.enqueue("anniversary:1", boar!);
    up.enqueue("forever:1", boar!);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([
      { auth: "Bearer tok_mirk", guild: "mirkwood" },
      { auth: "Bearer tok_order", guild: "order" },
    ]);
    expect(refused).toEqual([["revoked", "dev-order"]]);
  });
});

describe("skipReason", () => {
  const settings = { autoUpload: true, minFightSeconds: 20 };
  it("skips short trash, never bosses, and nothing when auto-upload is off or unpaired", () => {
    expect(skipReason(boar!, settings, true)).toBeNull();
    expect(skipReason(boar!, { ...settings, minFightSeconds: 60 }, true)).toBe("Shorter than 60 s");
    const boss = { ...boar!, fight: { ...boar!.fight, kind: "boss" as const, durationMs: 5000 } };
    expect(skipReason(boss, { ...settings, minFightSeconds: 60 }, true)).toBeNull();
    expect(skipReason(boar!, { ...settings, autoUpload: false }, true)).toBe("Auto-upload is off");
    expect(skipReason(boar!, settings, false)).toBe("Not paired with the site");
  });
});

describe("dungeon bosses without ENCOUNTER_START", () => {
  const reports = analyzeText(deadminesLog(), WARRIOR.guid, "protection-warrior", "Rhune");
  const settings = { autoUpload: true, minFightSeconds: 20 };
  const byLabel = (label: string) => reports.find((r) => r.fight.label === label)!;

  it("are analysed as trash, since the log has no encounter", () => {
    expect(reports.map((r) => [r.fight.kind, r.fight.label])).toEqual([
      ["trash", "Defias Miner"],
      ["trash", "Rhahk'Zor"],
      ["trash", "Defias Overseer"],
      ["trash", "Mr. Smite"],
      ["trash", "Edwin VanCleef"],
    ]);
  });

  it("become boss fights with the client's encounter ID, and a kill when the boss died", () => {
    const rhahk = asBossFight(byLabel("Rhahk'Zor"));
    expect(rhahk.fight).toMatchObject({ kind: "boss", label: "Rhahk'Zor", encounter: { id: 2741, name: "Rhahk'Zor", success: true } });
    const vancleef = asBossFight(byLabel("Edwin VanCleef"));
    expect(vancleef.fight).toMatchObject({ kind: "boss", label: "Edwin VanCleef", encounter: { id: 2747, success: true } });
    const wipe = { ...byLabel("Mr. Smite"), fight: { ...byLabel("Mr. Smite").fight, targets: byLabel("Mr. Smite").fight.targets.map((t) => ({ ...t, died: false })) } };
    expect(asBossFight(wipe).fight.encounter).toEqual({ id: 2745, name: "Mr. Smite" });
    const trash = byLabel("Defias Miner");
    expect(asBossFight(trash)).toBe(trash);
  });

  it("always upload, however short, while short trash is skipped", () => {
    const rhahk = byLabel("Rhahk'Zor");
    expect(rhahk.fight.durationMs).toBeLessThan(20_000);
    expect(skipReason(rhahk, settings, true)).toBeNull();
    expect(skipReason(asBossFight(rhahk), { ...settings, minFightSeconds: 600 }, true)).toBeNull();
    expect(skipReason(byLabel("Defias Miner"), settings, true)).toBe("Shorter than 20 s");
    expect(skipReason(byLabel("Defias Overseer"), settings, true)).toBe("Shorter than 20 s");
  });
});

describe("a Stockade run without ENCOUNTER_START", () => {
  const reports = analyzeText(stockadeLog(), WARRIOR.guid, "protection-warrior", "Rhune").map(asBossFight);
  const settings = { autoUpload: true, minFightSeconds: 20 };

  it("files each boss pull with its encounter, as a kill or (for the wipe) without success", () => {
    expect(reports.map((r) => [r.fight.kind, r.fight.label, r.fight.encounter ?? null])).toEqual([
      ["trash", "Defias Prisoner", null],
      ["trash", "Defias Captive", null],
      ["boss", "Targorr the Dread", { id: 2756, name: "Targorr the Dread", success: true }],
      ["boss", "Kam Deepfury", { id: 2757, name: "Kam Deepfury", success: true }],
      ["boss", "Hamhock", { id: 2758, name: "Hamhock" }],
      ["boss", "Hamhock", { id: 2758, name: "Hamhock", success: true }],
      ["trash", "Defias Insurgent", null],
      ["boss", "Bazil Thredd", { id: 2760, name: "Bazil Thredd", success: true }],
    ]);
  });

  it("uploads every boss pull, kill or wipe, and skips the short trash", () => {
    expect(reports.map((r) => [r.fight.label, skipReason(r, settings, true)])).toEqual([
      ["Defias Prisoner", "Shorter than 20 s"],
      ["Defias Captive", "Shorter than 20 s"],
      ["Targorr the Dread", null],
      ["Kam Deepfury", null],
      ["Hamhock", null],
      ["Hamhock", null],
      ["Defias Insurgent", "Shorter than 20 s"],
      ["Bazil Thredd", null],
    ]);
  });

  it("relabels a rare elite as a boss fight without an encounter", () => {
    const bazil = analyzeText(stockadeLog(), WARRIOR.guid, "protection-warrior", "Rhune").at(-1)!;
    const rare = { ...bazil, fight: { ...bazil.fight, label: "Bruegal Ironknuckle", targets: [{ ...bazil.fight.targets[0]!, npcId: 1720, name: "Bruegal Ironknuckle" }] } };
    const promoted = asBossFight(rare);
    expect(promoted.fight).toMatchObject({ kind: "boss", label: "Bruegal Ironknuckle" });
    expect(promoted.fight.encounter).toBeUndefined();
    expect(skipReason({ ...promoted, fight: { ...promoted.fight, durationMs: 5000 } }, settings, true)).toBeNull();
  });
});

describe("Uploader and the guild's game version", () => {
  it("passes on the site's warning for a log from another game", async () => {
    const warning = "This log is from TBC Anniversary; Order is a WoW: Forever guild. The report was saved with a warning.";
    const h = harness([json(201, { id: "r1", url: "u", gameVersion: "anniversary", versionMismatch: true, warning })]);
    h.up.enqueue("f1", boar!);
    await h.flush();
    expect(h.statuses.at(-1)![1]).toEqual({ state: "uploaded", url: "u", warning });
  });

  it("treats a version_mismatch refusal as final whatever the 4xx status, without unpairing", async () => {
    const h = harness([json(422, { error: "Other game.", code: "version_mismatch" }), json(403, { error: "Other game.", code: "version_mismatch" })]);
    h.up.enqueue("f1", boar!);
    h.up.enqueue("f2", boar!);
    await h.flush();
    await h.flush();
    expect(h.statuses.filter(([, s]) => s.state === "failed").map(([, s]) => s)).toEqual([
      { state: "failed", error: "Not uploaded: Other game.", retrying: false, final: true },
      { state: "failed", error: "Not uploaded: Other game.", retrying: false, final: true },
    ]);
    expect(h.unauthorized()).toBeNull();
    expect(h.timers).toHaveLength(0);
  });

  it("treats a refused mismatch as final, without a retry", async () => {
    const error = "This log is from TBC Anniversary; Order is a WoW: Forever guild. Pair Vigil with your TBC Anniversary guild.";
    const h = harness([json(409, { error, code: "version_mismatch" })]);
    h.up.enqueue("f1", boar!);
    await h.flush();
    expect(h.statuses.at(-1)![1]).toEqual({ state: "failed", error: `Not uploaded: ${error}`, retrying: false, final: true });
    expect(h.timers).toHaveLength(0);
    expect(h.up.pending).toBe(0);
  });
});
