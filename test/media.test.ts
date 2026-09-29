import { mkdtempSync, rmSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOOKUP_MISS_TTL_MS, MEDIA_TTL_MS, MediaCache, parseMediaUrl, SpellIconLookup, SpellIcons, upstreamUrl, upstreamUrls } from "../src/core/media";

const icons = new SpellIcons();

describe("SpellIcons (generated Classic Era and TBC data)", () => {
  it("knows class and boss spell icons by ID", () => {
    expect(icons.byId(7386)).toBe("ability_warrior_sunder");
    expect(icons.byId(20566)).toBe("spell_fire_soulburn");
    expect(icons.byId(20475)).toBe("inv_enchant_essenceastralsmall");
    expect(icons.byId(999_999_999)).toBeNull();
  });

  it("knows TBC spells", () => {
    expect(icons.byId(35395)).toBe("spell_holy_crusaderstrike");
    expect(icons.byId(31892)).toBe("spell_holy_sealofblood");
    expect(icons.byId(33878)).toBe("ability_druid_mangle2");
    expect(icons.classOf(35395)).toBe("paladin");
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

  it("answers unknown spells with nothing to fetch, keeping the ID for a lookup", () => {
    const req = parseMediaUrl("vigil-media://spell/36/999999", icons);
    expect(req).toEqual({ kind: "icon", size: 36, icon: null, spellId: 999999 });
    expect(upstreamUrl(req!)).toBeNull();
    expect(upstreamUrls(req!)).toEqual([]);
  });

  it("falls back to the spell's name when the map lacks its ID", () => {
    expect(parseMediaUrl("vigil-media://spell/36/999999?name=Sunder%20Armor", icons)).toEqual({ kind: "icon", size: 36, icon: "ability_warrior_sunder" });
    expect(parseMediaUrl("vigil-media://spell/36/7386?name=Frostbolt", icons)).toEqual({ kind: "icon", size: 36, icon: "ability_warrior_sunder" });
    expect(parseMediaUrl("vigil-media://spell/36/999999?name=Nope", icons)).toEqual({ kind: "icon", size: 36, icon: null, spellId: 999999 });
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

describe("SpellIconLookup", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "vigil-lookup-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

  it("asks Wowhead for TBC then Classic Era data by ID, and caches the answer on disk", async () => {
    const { f, calls } = fakeFetch((url) => (url.includes("dataEnv=5") ? json({ error: "Entity not found" }, 404) : json({ icon: "Spell_Holy_CrusaderStrike" })));
    const lookup = new SpellIconLookup({ dir, fetch: f, minIntervalMs: 0 });
    const [a, b] = await Promise.all([lookup.resolve(407676), lookup.resolve(407676)]);
    expect(a).toBe("spell_holy_crusaderstrike");
    expect(b).toBe("spell_holy_crusaderstrike");
    expect(await new SpellIconLookup({ dir, fetch: f }).resolve(407676)).toBe("spell_holy_crusaderstrike");
    expect(calls).toEqual([
      "https://nether.wowhead.com/tooltip/spell/407676?dataEnv=5",
      "https://nether.wowhead.com/tooltip/spell/407676?dataEnv=4",
    ]);
  });

  it("remembers spells nobody knows for a week, and ignores icon names that aren't safe", async () => {
    let now = Date.now();
    const { f, calls } = fakeFetch((url) => (url.includes("/1?") ? json({ icon: "../../etc" }) : json({ error: "ID is out of range" }, 404)));
    const lookup = () => new SpellIconLookup({ dir, fetch: f, now: () => now, minIntervalMs: 0 });
    expect(await lookup().resolve(1)).toBeNull();
    expect(await lookup().resolve(99_999_999)).toBeNull();
    expect(await lookup().resolve(99_999_999)).toBeNull();
    expect(calls).toHaveLength(4);
    now += LOOKUP_MISS_TTL_MS + 1000;
    expect(await lookup().resolve(99_999_999)).toBeNull();
    expect(calls).toHaveLength(6);
    expect(await lookup().resolve(0)).toBeNull();
    expect(await lookup().resolve(-5)).toBeNull();
    expect(calls).toHaveLength(6);
  });

  it("gives up quietly when offline, pauses, then tries again without having cached the failure", async () => {
    let now = 1_000_000;
    let offline = true;
    const { f, calls } = fakeFetch(() => (offline ? new Error("offline") : json({ icon: "spell_holy_sealofblood" })));
    const lookup = new SpellIconLookup({ dir, fetch: f, now: () => now, minIntervalMs: 0, backoffMs: 60_000 });
    expect(await lookup.resolve(31892)).toBeNull();
    offline = false;
    expect(await lookup.resolve(31892)).toBeNull();
    expect(calls).toHaveLength(1);
    now += 61_000;
    expect(await lookup.resolve(31892)).toBe("spell_holy_sealofblood");
    expect(readdirSync(dir)).toEqual(["spell-31892.json"]);
  });

  it("backs off when Wowhead is overloaded", async () => {
    const { f, calls } = fakeFetch(() => json({}, 429));
    const lookup = new SpellIconLookup({ dir, fetch: f, minIntervalMs: 0 });
    expect(await lookup.resolve(20243)).toBeNull();
    expect(await lookup.resolve(20244)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});
