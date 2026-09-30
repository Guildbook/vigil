import { describe, expect, it } from "vitest";
import {
  addPairing,
  defaultPairing,
  groupByVersion,
  LEGACY_TOKEN_FILE,
  loadPairingsFrom,
  pairingKey,
  pickPairing,
  setGameVersion,
  tokenFileFor,
  type Pairing,
} from "../src/core/pairings";

const NOW = new Date("2026-09-29T12:00:00.000Z");

function pairing(slug: string, name: string, gameVersion: Pairing["guild"]["gameVersion"], extra: Partial<Pairing> = {}): Pairing {
  return {
    id: `dev-${slug}`,
    guild: { slug, name, gameVersion },
    siteUrl: `https://${slug}.guildbook.io`,
    device: { id: `dev-${slug}`, name: "Vigil on test" },
    pairedAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    tokenFile: tokenFileFor(`dev-${slug}`),
    ...extra,
  };
}

const ORDER = pairing("order", "Order", "forever");
const MIRKWOOD = pairing("mirkwood", "Mirkwood", "anniversary");

describe("loadPairingsFrom (migration from 0.4.0)", () => {
  const legacy = {
    siteUrl: "https://order.guildbook.io",
    guild: { slug: "order", name: "Order" },
    device: { id: "d1", name: "Vigil on desk" },
  };

  it("turns the single 0.4.0 pairing into one entry that keeps its token file, with the game version unknown", () => {
    expect(loadPairingsFrom(null, legacy, NOW)).toEqual({
      migrated: true,
      pairings: [
        {
          id: "d1",
          guild: { slug: "order", name: "Order", gameVersion: null },
          siteUrl: "https://order.guildbook.io",
          device: { id: "d1", name: "Vigil on desk" },
          pairedAt: NOW.toISOString(),
          lastUsedAt: null,
          tokenFile: LEGACY_TOKEN_FILE,
        },
      ],
    });
  });

  it("keeps a game version the old file already had", () => {
    const { pairings } = loadPairingsFrom(null, { ...legacy, guild: { ...legacy.guild, gameVersion: "anniversary" } }, NOW);
    expect(pairings[0]!.guild.gameVersion).toBe("anniversary");
    expect(pairingKey(pairings[0]!)).toBe("anniversary");
  });

  it("prefers the new file and ignores the old one once written", () => {
    const saved = { version: 2, pairings: [ORDER, MIRKWOOD] };
    expect(loadPairingsFrom(saved, legacy, NOW)).toEqual({ migrated: false, pairings: [ORDER, MIRKWOOD] });
  });

  it("has nothing to migrate without an old pairing, or with a broken one", () => {
    expect(loadPairingsFrom(null, null, NOW)).toEqual({ pairings: [], migrated: false });
    expect(loadPairingsFrom(null, { guild: { slug: "order" } }, NOW)).toEqual({ pairings: [], migrated: false });
  });

  it("drops entries without a guild or device, unknown game versions and token files outside the naming scheme", () => {
    const saved = {
      version: 2,
      pairings: [
        { ...ORDER, guild: { ...ORDER.guild, gameVersion: "retail" } },
        { ...MIRKWOOD, tokenFile: "../../etc/passwd" },
        { guild: { slug: "x" } },
      ],
    };
    const { pairings } = loadPairingsFrom(saved, null, NOW);
    expect(pairings).toEqual([{ ...ORDER, guild: { ...ORDER.guild, gameVersion: null } }]);
  });

  it("keeps the most recent pairing when the file has two for one game version", () => {
    const older = pairing("old", "Old Guild", "forever", { pairedAt: "2026-01-01T00:00:00.000Z" });
    expect(loadPairingsFrom({ version: 2, pairings: [ORDER, older] }, null, NOW).pairings).toEqual([ORDER]);
  });
});

describe("addPairing", () => {
  it("keeps one guild per game version", () => {
    const { pairings, replaced } = addPairing([ORDER], MIRKWOOD);
    expect(pairings).toEqual([ORDER, MIRKWOOD]);
    expect(replaced).toEqual([]);
  });

  it("replaces the guild of the same game version", () => {
    const other = pairing("other", "Other Forever Guild", "forever");
    const { pairings, replaced } = addPairing([ORDER, MIRKWOOD], other);
    expect(pairings).toEqual([MIRKWOOD, other]);
    expect(replaced).toEqual([ORDER]);
  });

  it("replaces the same guild paired again, and keys a guild of unknown version by its slug", () => {
    const again = pairing("order", "Order", null, { id: "dev-2", tokenFile: tokenFileFor("dev-2") });
    expect(pairingKey(again)).toBe("guild:order");
    expect(addPairing([ORDER, MIRKWOOD], again)).toEqual({ pairings: [MIRKWOOD, again], replaced: [ORDER] });
    const unknown = pairing("third", "Third", null);
    expect(addPairing([again], unknown).pairings).toEqual([again, unknown]);
  });
});

describe("setGameVersion", () => {
  it("fills in a version learned from the site's profile", () => {
    const migrated = pairing("order", "Order", null);
    expect(setGameVersion([migrated], migrated.id, "forever").pairings[0]!.guild.gameVersion).toBe("forever");
  });

  it("lets the newer pairing win when the version collides with another", () => {
    const older = pairing("old", "Old", "forever", { pairedAt: "2026-01-01T00:00:00.000Z" });
    const fresh = pairing("order", "Order", null, { pairedAt: "2026-09-02T00:00:00.000Z" });
    const r = setGameVersion([older, fresh], fresh.id, "forever");
    expect(r.pairings.map((p) => [p.guild.slug, p.guild.gameVersion])).toEqual([["order", "forever"]]);
    expect(r.replaced).toEqual([older]);
    const stale = setGameVersion([{ ...fresh, pairedAt: "2025-01-01T00:00:00.000Z" }, older], fresh.id, "forever");
    expect(stale.pairings).toEqual([older]);
  });

  it("changes nothing without a version", () => {
    expect(setGameVersion([ORDER], ORDER.id, null)).toEqual({ pairings: [ORDER], replaced: [] });
  });
});

describe("pickPairing", () => {
  it("has nothing to pick without pairings", () => {
    expect(pickPairing([], "forever")).toEqual({ pairing: null, reason: "none", warning: null, mismatch: false });
  });

  it("sends each log to the guild of its game", () => {
    expect(pickPairing([ORDER, MIRKWOOD], "anniversary")).toMatchObject({ pairing: MIRKWOOD, reason: "match", warning: null });
    expect(pickPairing([ORDER, MIRKWOOD], "forever")).toMatchObject({ pairing: ORDER, reason: "match", warning: null });
  });

  it("falls back to the only guild with a warning when it is another game", () => {
    expect(pickPairing([ORDER], "anniversary")).toEqual({
      pairing: ORDER,
      reason: "only",
      mismatch: true,
      warning: "This log is from TBC Anniversary but Vigil is only paired with Order (WoW: Forever). Pair Vigil with your TBC Anniversary guild.",
    });
  });

  it("uses the only guild silently while its game is not known yet", () => {
    const migrated = pairing("order", "Order", null);
    expect(pickPairing([migrated], "anniversary")).toEqual({ pairing: migrated, reason: "unknown-guild", warning: null, mismatch: false });
  });

  it("with several guilds and none of the log's game, prefers one of unknown game, else the most recently used", () => {
    const era = pairing("era", "Era Folk", "era", { lastUsedAt: "2026-09-20T00:00:00.000Z" });
    const unknown = pairing("new", "New Guild", null);
    expect(pickPairing([ORDER, unknown], "anniversary")).toMatchObject({ pairing: unknown, reason: "unknown-guild", warning: null });
    const r = pickPairing([ORDER, era], "anniversary");
    expect(r).toMatchObject({ pairing: era, reason: "fallback", mismatch: true });
    expect(r.warning).toBe(
      "This log is from TBC Anniversary but none of your paired guilds is, so it goes to Era Folk (Classic Era). Pair Vigil with your TBC Anniversary guild.",
    );
  });

  it("with several guilds of unknown game, warns that it had to guess", () => {
    const a = pairing("a", "Alpha", null, { lastUsedAt: "2026-09-10T00:00:00.000Z" });
    const b = pairing("b", "Beta", null);
    expect(pickPairing([a, b], "forever")).toMatchObject({ pairing: a, reason: "fallback", mismatch: false });
  });

  it("sends a log of unknown game to the only guild, or the most recently used with a warning", () => {
    expect(pickPairing([ORDER], null)).toEqual({ pairing: ORDER, reason: "only", warning: null, mismatch: false });
    const used = { ...MIRKWOOD, lastUsedAt: "2026-09-28T00:00:00.000Z" };
    const r = pickPairing([ORDER, used], undefined);
    expect(r).toMatchObject({ pairing: used, reason: "unknown-log", mismatch: false });
    expect(r.warning).toBe("Vigil could not tell which game this log is from, so it goes to Mirkwood (TBC Anniversary).");
  });

  it("writes warnings without middots or emoji", () => {
    const warnings = [pickPairing([ORDER], "anniversary"), pickPairing([ORDER, MIRKWOOD], null), pickPairing([ORDER, pairing("e", "E", "era")], "anniversary")]
      .map((r) => r.warning)
      .join("\n");
    expect(warnings).not.toMatch(/[\u00b7\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe("defaultPairing and groupByVersion", () => {
  it("defaults to the most recently used guild, then the most recently paired", () => {
    const fresh = pairing("fresh", "Fresh", "era", { pairedAt: "2026-09-10T00:00:00.000Z" });
    expect(defaultPairing([ORDER, fresh])).toBe(fresh);
    expect(defaultPairing([{ ...ORDER, lastUsedAt: "2026-09-20T00:00:00.000Z" }, fresh])!.guild.slug).toBe("order");
    expect(defaultPairing([])).toBeNull();
  });

  it("groups guilds by game version, Forever first and unknown last", () => {
    const unknown = pairing("new", "New Guild", null);
    expect(groupByVersion([unknown, MIRKWOOD, ORDER]).map((g) => [g.label, g.pairings.map((p) => p.guild.name)])).toEqual([
      ["WoW: Forever", ["Order"]],
      ["TBC Anniversary", ["Mirkwood"]],
      ["Game not known yet", ["New Guild"]],
    ]);
  });
});
