import { describe, expect, it } from "vitest";
import { analyzeText } from "@/lib/vigil/analyze";
import type { UploadState } from "../src/core/protocol";
import { skipReason, Uploader, type UploadTarget } from "../src/core/uploader";
import { PALADIN, paladinLog } from "./support/combatlog";

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
    expect(h.statuses.filter(([id]) => id === "f1").at(-1)![1]).toEqual({ state: "failed", error: "bad format", retrying: false });
    expect(h.statuses.filter(([id]) => id === "f2").at(-1)![1]).toEqual({ state: "failed", error: "revoked", retrying: false });
    expect(h.unauthorized()).toBe("revoked");
    expect(h.timers).toEqual([]);
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
