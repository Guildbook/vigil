import { mkdtempSync, rmSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEDIA_TTL_MS, MediaCache, parseMediaUrl, SpellIcons, upstreamUrl, upstreamUrls } from "../src/core/media";

const icons = new SpellIcons();

describe("SpellIcons (generated Classic Era data)", () => {
  it("knows class and boss spell icons by ID", () => {
    expect(icons.byId(7386)).toBe("ability_warrior_sunder");
    expect(icons.byId(20566)).toBe("spell_fire_soulburn");
    expect(icons.byId(20475)).toBe("inv_enchant_essenceastralsmall");
    expect(icons.byId(999_999_999)).toBeNull();
  });

  it("finds class spells by name, ignoring case and rank", () => {
    expect(icons.byName("Sunder Armor")).toBe("ability_warrior_sunder");
    expect(icons.byName("  judgement ")).toBe(icons.byId(20271));
    expect(icons.byName("Not A Spell")).toBeNull();
  });

  it("tells which class a spell belongs to", () => {
    expect(icons.classOf(7386)).toBe("warrior");
    expect(icons.classOf(19968)).toBe("paladin");
    expect(icons.classOf(9841)).toBe("druid");
    expect(icons.classOf(20566)).toBeNull();
  });

  it("never names an icon the CDN lacks", () => {
    const custom = new SpellIcons({ icons: ["a_ok", "b_gone"], spells: { 1: 0, 2: 1 }, names: {}, classes: {}, missing: ["b_gone"] });
    expect(custom.byId(1)).toBe("a_ok");
    expect(custom.byId(2)).toBeNull();
  });
});

describe("vigil-media URLs", () => {
  it("resolves spells, names, icons and NPC renders to the render CDN", () => {
    const at = (u: string) => {
      const req = parseMediaUrl(u, icons);
      return req ? upstreamUrl(req) : undefined;
    };
    expect(at("vigil-media://spell/36/7386")).toBe("https://render.worldofwarcraft.com/us/icons/36/ability_warrior_sunder.jpg");
    expect(at("vigil-media://spell-name/18/Sunder%20Armor")).toBe("https://render.worldofwarcraft.com/us/icons/18/ability_warrior_sunder.jpg");
    expect(at("vigil-media://icon/56/ability_meleedamage")).toBe("https://render.worldofwarcraft.com/us/icons/56/ability_meleedamage.jpg");
    expect(at("vigil-media://npc/portrait/11121")).toBe("https://render.worldofwarcraft.com/us/npcs/portrait/creature-display-11121.jpg");
    expect(at("vigil-media://npc/zoom/8570")).toBe("https://render.worldofwarcraft.com/us/npcs/zoom/creature-display-8570.jpg");
  });

  it("answers unknown spells with nothing to fetch (the fallback icon)", () => {
    const req = parseMediaUrl("vigil-media://spell/36/999999", icons);
    expect(req).toEqual({ kind: "icon", size: 36, icon: null });
    expect(upstreamUrl(req!)).toBeNull();
    expect(upstreamUrls(req!)).toEqual([]);
  });

  it("falls back from a missing portrait to the large render", () => {
    expect(upstreamUrls(parseMediaUrl("vigil-media://npc/portrait/15931", icons)!)).toEqual([
      "https://render.worldofwarcraft.com/us/npcs/portrait/creature-display-15931.jpg",
      "https://render.worldofwarcraft.com/us/npcs/zoom/creature-display-15931.jpg",
    ]);
    expect(upstreamUrls(parseMediaUrl("vigil-media://icon/36/ability_meleedamage", icons)!)).toHaveLength(1);
  });

  it("rejects anything that could reach elsewhere", () => {
    for (const u of [
      "https://render.worldofwarcraft.com/us/icons/36/x.jpg",
      "vigil-media://icon/36/..%2F..%2Fetc",
      "vigil-media://icon/36/a/b",
      "vigil-media://icon/40/ability_meleedamage",
      "vigil-media://npc/main/11121",
      "vigil-media://npc/zoom/-1",
      "vigil-media://spell/36/12ab",
      "vigil-media://other/36/x",
      "not a url",
    ]) {
      expect(parseMediaUrl(u, icons), u).toBeNull();
    }
  });
});

describe("MediaCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "vigil-media-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const URL1 = "https://render.worldofwarcraft.com/us/icons/36/ability_warrior_sunder.jpg";

  function fakeFetch(respond: (url: string) => Response | Error) {
    const calls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const r = respond(url);
      if (r instanceof Error) throw r;
      return r;
    }) as typeof fetch;
    return { f, calls };
  }
  const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });

  it("downloads once, serves from disk after, and shares concurrent requests", async () => {
    const { f, calls } = fakeFetch(() => jpeg());
    const cache = new MediaCache({ dir, fetch: f });
    const [a, b] = await Promise.all([cache.get(URL1), cache.get(URL1)]);
    expect(a?.length).toBe(3);
    expect(b?.length).toBe(3);
    expect(await new MediaCache({ dir, fetch: f }).get(URL1)).not.toBeNull();
    expect(calls).toEqual([URL1]);
  });

  it("refetches after 30 days and prunes expired files", async () => {
    let now = Date.now();
    const { f, calls } = fakeFetch(() => jpeg());
    const cache = new MediaCache({ dir, fetch: f, now: () => now, ttlMs: 90 * 24 * 3600_000 });
    await cache.get(URL1);
    now += MEDIA_TTL_MS + 1000;
    await cache.get(URL1);
    expect(calls.length).toBe(2);

    const old = path.join(dir, "old.jpg");
    writeFileSync(old, "x");
    const past = (Date.now() - MEDIA_TTL_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    new MediaCache({ dir, fetch: f }).prune();
    expect(readdirSync(dir)).not.toContain("old.jpg");
  });

  it("only contacts the render CDN, remembers missing art, and retries after network errors", async () => {
    let offline = true;
    const { f, calls } = fakeFetch((url) =>
      url.includes("missing") ? new Response("no", { status: 403, headers: { "content-type": "application/xml" } }) : offline ? new Error("offline") : jpeg(),
    );
    const cache = new MediaCache({ dir, fetch: f });
    expect(await cache.get("https://example.com/x.jpg")).toBeNull();
    const missing = "https://render.worldofwarcraft.com/us/npcs/zoom/creature-display-missing.jpg";
    expect(await cache.get(missing)).toBeNull();
    expect(await cache.get(missing)).toBeNull();
    expect(await cache.get(URL1)).toBeNull();
    offline = false;
    expect(await cache.get(URL1)).not.toBeNull();
    expect(calls).toEqual([missing, URL1, URL1]);
  });
});
