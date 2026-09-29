import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanionEngine } from "../src/core/engine";
import { factionFromClasses, GroupObserver, GroupReader, type GroupFightView } from "../src/core/group";
import { SpellIcons } from "../src/core/media";
import type { CompletedFight } from "@/lib/vigil/live";
import { deadminesLog, PALADIN, paladinLog, raidLog, stockadeLog, warriorLog } from "./support/combatlog";

const icons = new SpellIcons();

function observe(text: string, classFor?: (name: string) => "mage" | null) {
  const finished: GroupFightView[] = [];
  const obs = new GroupObserver({ icons, classFor, onFinished: (f) => finished.push(f) });
  const reader = new GroupReader(2026);
  let last = 0;
  for (const line of text.split("\n")) {
    const ev = reader.read(line);
    if (ev) {
      obs.push(ev);
      last = ev.t;
    }
  }
  obs.tick(last + 120_000);
  return { obs, finished };
}

describe("GroupObserver on a Ragnaros kill", () => {
  const { finished } = observe(raidLog());
  const rag = finished.find((f) => f.kind === "boss")!;

  it("recognises the encounter and its boss", () => {
    expect(finished).toHaveLength(1);
    expect(rag.encounter).toEqual({ id: 672, name: "Ragnaros", success: true });
    expect(rag.boss).toEqual({
      key: "ragnaros",
      name: "Ragnaros",
      instance: "Molten Core",
      instanceKind: "raid",
      displayId: 11121,
      status: "full",
      via: "encounter",
    });
    expect(rag.result).toBe("kill");
    expect(rag.durationMs).toBe(60_200);
  });

  it("tells every player's class from what they cast, and the faction from the classes", () => {
    const classes = Object.fromEntries(rag.players.map((p) => [p.name, p.wowClass]));
    expect(classes).toEqual({
      Rhune: "warrior",
      Aelwyn: "paladin",
      Sorrel: "priest",
      Vexa: "mage",
      Kestrel: "rogue",
      Bramble: "hunter",
      Nyx: "warlock",
      Fen: "druid",
      Brakk: "warrior",
    });
    expect(rag.faction).toBe("alliance");
    expect(rag.players.find((p) => p.isMe)?.name).toBe("Rhune");
  });

  it("builds damage and healing meters", () => {
    const top = rag.players[0]!;
    expect(top.damage).toBeGreaterThan(0);
    expect(rag.players.map((p) => p.damage)).toEqual([...rag.players.map((p) => p.damage)].sort((a, b) => b - a));
    const healer = rag.players.find((p) => p.name === "Sorrel")!;
    expect(healer.healing).toBeGreaterThan(0);
    expect(healer.hps).toBeCloseTo(healer.healing / 60.2, 5);
    const me = rag.players.find((p) => p.isMe)!;
    expect(me.spells.map((s) => s.name)).toContain("Revenge");
    expect(rag.players.find((p) => !p.isMe)!.spells).toEqual([]);
  });

  it("records deaths with the killing blow, including lava", () => {
    expect(rag.deaths.map((d) => [d.name, d.wowClass, d.blow?.name, d.blow?.source])).toEqual([
      ["Kestrel", "rogue", "Wrath of Ragnaros", "Ragnaros"],
      ["Nyx", "warlock", "Lava", "Environment"],
    ]);
    expect(rag.deaths[0]!.offsetMs).toBe(31_050);
    expect(rag.deaths[1]!.blow!.amount).toBe(2400);
  });

  it("totals the boss's abilities and links them to the intel", () => {
    const wrath = rag.abilities.find((a) => a.name === "Wrath of Ragnaros")!;
    expect(wrath).toMatchObject({ spellId: 20566, source: "Ragnaros", hits: 9, players: 3, kills: 1, intelKey: "wrath-of-ragnaros" });
    expect(wrath.damage).toBe(3 * (1400 + 2300 + 2200));
    expect(wrath.topTargets[0]).toEqual({ name: "Kestrel", wowClass: "rogue", amount: 6900 });
    expect(rag.abilities.find((a) => a.name === "Lava Burst")?.intelKey).toBe("lava-burst");
    expect(rag.abilities.find((a) => a.name === "Elemental Fire")?.intelKey).toBe("elemental-fire");
    expect(rag.abilities.find((a) => a.name === "Magma Blast")?.intelKey).toBe("magma-blast");
    expect(rag.abilities.find((a) => a.name === "Melee")?.intelKey).toBeNull();
  });
});

describe("GroupObserver on a Deadmines run without ENCOUNTER_START", () => {
  const { finished } = observe(deadminesLog());
  const fights = finished;

  it("recognises dungeon bosses by their units and keeps trash apart", () => {
    expect(fights.map((f) => [f.kind, f.label, f.boss?.key ?? null, f.result])).toEqual([
      ["trash", "Defias Miner", null, null],
      ["boss", "Rhahk'Zor", "rhahkzor", "kill"],
      ["trash", "Defias Overseer", null, null],
      ["boss", "Mr. Smite", "mr-smite", "kill"],
      ["boss", "Edwin VanCleef", "edwin-vancleef", "kill"],
    ]);
    for (const f of fights.filter((x) => x.boss)) {
      expect(f.encounter).toBeNull();
      expect(f.boss).toMatchObject({ instance: "The Deadmines", instanceKind: "dungeon", via: "unit" });
    }
    expect(fights[1]!.durationMs).toBeLessThan(20_000);
  });

  it("links the bosses' abilities to the intel and counts the adds' kills", () => {
    const smite = fights[3]!;
    expect(smite.abilities.find((a) => a.name === "Smite Stomp")).toMatchObject({ spellId: 6432, hits: 4, players: 2 });
    expect(smite.abilities.find((a) => a.name === "Smite Stomp")?.intelKey).toBe("smite-stomp");
    const vancleef = fights[4]!;
    expect(vancleef.deaths.map((d) => [d.name, d.blow?.source])).toEqual([["Vexa", "Defias Blackguard"]]);
    expect(vancleef.abilities.find((a) => a.source === "Defias Blackguard")?.kills).toBe(1);
    expect(vancleef.players).toHaveLength(5);
    expect(vancleef.abilities.find((a) => a.name === "VanCleef's Allies")).toMatchObject({ intelKey: "vancleefs-allies", casts: 1, damage: 0 });
  });

  it("shows a unit-recognised boss while the fight is live", () => {
    const text = deadminesLog();
    const obs = new GroupObserver({ icons });
    const reader = new GroupReader(2026);
    let live: GroupFightView | null = null;
    for (const line of text.split("\n")) {
      const ev = reader.read(line);
      if (!ev) continue;
      obs.push(ev);
      const now = obs.current(ev.t);
      if (now?.boss?.key === "mr-smite") live = now;
      if (live) break;
    }
    expect(live).toMatchObject({ live: true, kind: "boss", result: null, boss: { key: "mr-smite", via: "unit" } });
  });
});

describe("GroupObserver on a Stockade run without ENCOUNTER_START", () => {
  const { finished: fights } = observe(stockadeLog());

  it("recognises every boss by unit, with kills, a wipe and the re-pull as separate fights", () => {
    expect(fights.map((f) => [f.kind, f.label, f.boss?.key ?? null, f.result])).toEqual([
      ["trash", "Defias Prisoner", null, null],
      ["trash", "Defias Captive", null, null],
      ["boss", "Targorr the Dread", "targorr-the-dread", "kill"],
      ["boss", "Kam Deepfury", "kam-deepfury", "kill"],
      ["boss", "Hamhock", "hamhock", "wipe"],
      ["boss", "Hamhock", "hamhock", "kill"],
      ["trash", "Defias Insurgent", null, null],
      ["boss", "Bazil Thredd", "bazil-thredd", "kill"],
    ]);
    for (const f of fights.filter((x) => x.boss)) {
      expect(f.encounter).toBeNull();
      expect(f.boss).toMatchObject({ instance: "The Stockade", instanceKind: "dungeon", via: "unit", status: "full" });
    }
    expect(fights[2]!.durationMs).toBeLessThan(20_000);
  });

  it("records who died in the wipe and to what", () => {
    const wipe = fights[4]!;
    expect(wipe.deaths.map((d) => [d.name, d.blow?.source])).toEqual([
      ["Sorrel", "Defias Prisoner"],
      ["Vexa", "Hamhock"],
      ["Nyx", "Hamhock"],
      ["Kestrel", "Defias Prisoner"],
      ["Rhune", "Hamhock"],
    ]);
    expect(wipe.abilities.find((a) => a.name === "Chain Lightning")).toMatchObject({ intelKey: "chain-lightning", hits: 9, players: 4 });
  });

  it("counts casts of listed abilities that never hit a player, once per cast", () => {
    const bazil = fights[7]!;
    const find = (name: string) => bazil.abilities.find((a) => a.name === name);
    expect(find("Battle Shout")).toMatchObject({ intelKey: "battle-shout", casts: 2, damage: 0, debuffs: 0 });
    expect(find("Dual Wield")).toMatchObject({ intelKey: "dual-wield", casts: 1 });
    expect(find("Smoke Bomb")).toMatchObject({ intelKey: "smoke-bomb", casts: 2, debuffs: 6, players: 3 });
    expect(fights[5]!.abilities.find((a) => a.name === "Bloodlust")).toMatchObject({ casts: 1 });
    expect(fights[2]!.abilities.find((a) => a.name === "Enrage")).toMatchObject({ intelKey: "enrage", casts: 1 });
    // Trash casts are not boss abilities.
    expect(fights[6]!.abilities.find((a) => a.name === "Battle Shout")).toBeUndefined();
  });
});

describe("GroupObserver on solo play", () => {
  it("splits trash pulls and encounters, and prefers the class the site knows", () => {
    const { finished } = observe(warriorLog(), (name) => (name === "Rhune" ? "mage" : null));
    expect(finished.map((f) => [f.kind, f.label])).toEqual([
      ["trash", "Defias Pillager"],
      ["boss", "Rhahk'Zor"],
    ]);
    expect(finished[1]!.boss).toMatchObject({ key: "rhahkzor", instance: "The Deadmines", instanceKind: "dungeon", via: "encounter" });
    expect(finished[0]!.boss).toBeNull();
    expect(finished[1]!.players[0]!.wowClass).toBe("mage");
    expect(finished[0]!.faction).toBeNull();
  });

  it("knows the Classic Era faction classes", () => {
    expect(factionFromClasses(["warrior", "shaman"])).toBe("horde");
    expect(factionFromClasses([null, "paladin"])).toBe("alliance");
    expect(factionFromClasses(["mage", null])).toBeNull();
  });
});

describe("CompanionEngine with the group observer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "vigil-group-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("shows the group live and hands over the finished fight", async () => {
    const text = raidLog();
    const lines = text.split("\n");
    const cut = lines.findIndex((l) => l.includes("Lava Burst"));
    const file = path.join(dir, "WoWCombatLog.txt");
    writeFileSync(file, `${lines.slice(0, cut).join("\n")}\n`);
    const finished: GroupFightView[] = [];
    const wall = 1_000_000;
    const e = new CompanionEngine({
      logsDir: dir,
      startAt: "start",
      wall: () => wall,
      session: { fallbackYear: 2026 },
      group: { icons, onFinished: (f) => finished.push(f) },
    });
    await e.poll();
    const live = e.tick().group!;
    expect(live.live).toBe(true);
    expect(live.boss?.key).toBe("ragnaros");
    expect(live.players.length).toBeGreaterThan(5);

    writeFileSync(file, text);
    await e.poll();
    e.tick();
    expect(finished.map((f) => f.encounter?.id)).toEqual([672]);
    expect(e.groupFights()[0]!.deaths).toHaveLength(2);
    expect(e.classOf("Player-4395-0000C003")).toBe("mage");
  });
});

describe("GroupObserver on an encounter Vigil has no notes for", () => {
  // Ragnaros's kill relabelled as Karazhan's Attumen (encounter 652, NPC 15550), which the boss data does not know yet.
  const text = raidLog()
    .replaceAll("Ragnaros", "Attumen the Huntsman")
    .replaceAll("-11502-", "-15550-")
    .replace(/ENCOUNTER_(START|END),672,/g, "ENCOUNTER_$1,652,");
  const { finished } = observe(text);

  it("still tracks a boss fight named from the log", () => {
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      kind: "boss",
      label: "Attumen the Huntsman",
      encounter: { id: 652, name: "Attumen the Huntsman", success: true },
      boss: null,
      result: "kill",
    });
  });
});

describe("CompanionEngine and the game version", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "vigil-version-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function run(flavor: string, header: string) {
    const dir = path.join(root, "World of Warcraft", flavor, "Logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "WoWCombatLog.txt"), paladinLog().replace(/BUILD_VERSION,[^,]+,PROJECT_ID,\d+/, header));
    const fights: CompletedFight[] = [];
    const e = new CompanionEngine({
      logsDir: dir,
      startAt: "start",
      session: { fallbackYear: 2026, playerGuid: PALADIN.guid },
      onFight: (f) => fights.push(f),
    });
    await e.poll();
    const snap = e.tick();
    e.stop();
    return { snap, fights };
  }

  it("tells Classic Era from Forever by the install folder, and stamps it on reports", async () => {
    const { snap, fights } = await run("_classic_era_", "BUILD_VERSION,1.15.7,PROJECT_ID,2");
    expect(snap.log).toMatchObject({ build: "1.15.7", projectId: 2, flavor: "_classic_era_", gameVersion: "era" });
    expect(fights.length).toBeGreaterThan(0);
    expect(fights[0]!.report.gameVersion).toBe("era");
    expect(fights[0]!.report.log.flavor).toBe("_classic_era_");
  });

  it("reads TBC Anniversary from the log header", async () => {
    const { snap, fights } = await run("_anniversary_", "BUILD_VERSION,2.5.6,PROJECT_ID,5");
    expect(snap.log.gameVersion).toBe("anniversary");
    expect(fights[0]!.report.gameVersion).toBe("anniversary");
  });
});
