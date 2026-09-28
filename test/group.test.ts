import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanionEngine } from "../src/core/engine";
import { factionFromClasses, GroupObserver, GroupReader, type GroupFightView } from "../src/core/group";
import { SpellIcons } from "../src/core/media";
import { raidLog, warriorLog } from "./support/combatlog";

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
    expect(rag.boss).toEqual({ key: "ragnaros", name: "Ragnaros", raid: "Molten Core", displayId: 11121, status: "full" });
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

describe("GroupObserver on solo play", () => {
  it("splits trash pulls and encounters, and prefers the class the site knows", () => {
    const { finished } = observe(warriorLog(), (name) => (name === "Rhune" ? "mage" : null));
    expect(finished.map((f) => [f.kind, f.label])).toEqual([
      ["trash", "Defias Pillager"],
      ["boss", "Rhahk'Zor"],
    ]);
    expect(finished[1]!.boss).toBeNull();
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
