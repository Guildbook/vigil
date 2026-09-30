import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { splitLines } from "@/lib/combatlog/lines";
import { LogReader } from "@/lib/combatlog/scan";
import type { CombatEvent } from "@/lib/combatlog/types";
import { LiveSession } from "@/lib/vigil/live";
import { loadAddon, lua, type Addon, type Flavor } from "./addon-harness";

/** The same TBC Anniversary (2.5.6) sample the desktop engine's tests use: a Retribution Paladin in Nagrand. */
const text = readFileSync(join(__dirname, "fixtures/logs/tbc-anniversary-2.5.6.txt"), "utf8");
const PALADIN = "Player-6064-0000A001";

function fixtureEvents(): CombatEvent[] {
  const reader = new LogReader(2026);
  const out: CombatEvent[] = [];
  for (const line of splitLines(text)) {
    const ev = reader.read(line);
    if (ev) out.push(ev);
  }
  return out;
}

interface FightSummary {
  label: string;
  kind: string;
  boss?: string;
  duration: number;
  damage: number;
  petDamage: number;
  dps: number;
  playerDps: number;
  healing: number;
  taken: number;
  active: number;
  idle: number;
  targets: number;
}

let addon: Addon | null = null;
afterEach(() => {
  addon?.close();
  addon = null;
});

async function load(flavor: Flavor = "tbc", savedVariables?: string, setup?: string) {
  addon = await loadAddon({ flavor, savedVariables, setup });
  return addon;
}

/** The live panel's rows as "Label=value", with secret values shown as the player would see them. */
async function panelRows(a: Addon): Promise<string[]> {
  return a.json<string[]>(`(function()
    local t = {}
    for _, row in ipairs(VigilLivePanel.rows) do
      if row.label:IsShown() then t[#t + 1] = row.label:Shown() .. "=" .. tostring(row.value:Shown()) end
    end
    return t
  end)()`);
}

/** Synthetic combat event rows: `ts` is seconds from the start of the scenario. */
const T0 = 1790000000;
const ME = `${lua(PALADIN)}, "Paladin", 0x511, 0`;
const mob = (npcId: number, name: string, spawn = "0000AAAA") => `"Creature-0-6259-409-120-${npcId}-${spawn}", ${lua(name)}, 0xa48, 0`;
const row = (ts: number, sub: string, src: string, dst: string, ...rest: unknown[]) =>
  `H.cleu(${[T0 + ts, lua(sub), "false", src, dst, ...rest.map((v) => (typeof v === "string" && v.startsWith("@") ? v.slice(1) : lua(v)))].join(", ")})`;
const swing = (ts: number, src: string, dst: string, amount: number) => row(ts, "SWING_DAMAGE", src, dst, amount, -1, 1, null, null, null, false, false, false, false);
const cast = (ts: number, dst: string, spellId: number, name: string) => row(ts, "SPELL_CAST_SUCCESS", ME, dst, spellId, name, 1);
const aura = (ts: number, sub: string, spellId: number, name: string) => row(ts, sub, ME, ME, spellId, name, 1, "BUFF");

describe("Vigil addon in a Lua VM", () => {
  it.each(["era", "tbc", "retail", "forever"] as Flavor[])("loads and starts without errors on the %s client", async (flavor) => {
    const a = await load(flavor);
    expect(await a.errors()).toEqual([]);
    expect(await a.json("H.ns.version")).toBe("0.3.3");
    expect(await a.json("VigilDB.version")).toBe(2);
    expect(await a.json("VigilLivePanel ~= nil and VigilMinimapButton ~= nil")).toBe(true);
    expect(await a.json("H.ns.intel.count")).toBeGreaterThan(200);
    // Classic clients: registered, unknown until the first event. 12.x clients: known restricted, never registered.
    const classic = flavor === "era" || flavor === "tbc";
    expect(await a.json("H.ns.fight.available")).toBe(classic ? null : false);
    expect(await a.json("#(H.events.COMBAT_LOG_EVENT_UNFILTERED or {})")).toBe(classic ? 1 : 0);
    expect(await a.json("#H.blocked")).toBe(0);
    await a.run(`SlashCmdList.VIGIL("") SlashCmdList.VIGIL("status") SlashCmdList.VIGIL("help") VigilMinimapButton.scripts.OnEnter(VigilMinimapButton)`);
    expect(await a.errors()).toEqual([]);
    expect(await a.json("VigilPanel:IsShown()")).toBe(true);
    const height = await a.json<number>("VigilPanel:GetHeight()");
    expect(height).toBeGreaterThan(300);
    expect(await a.json("GameTooltip.lines[1]")).toBe("Vigil | v0.3.3");
  });

  it.each(["era", "tbc", "retail", "forever"] as Flavor[])("presses, drags and clicks the masked minimap button on the %s client", async (flavor) => {
    const a = await load(flavor);
    expect(await a.json("VigilMinimapButton.icon.masked")).toBe(true);
    const offsets = "(function() local p, _, _, x, y = VigilMinimapButton.icon:GetPoint() return { p, x, y } end)()";
    const start = await a.json<[string, number, number]>(offsets);
    await a.run(`local b = VigilMinimapButton
      b.scripts.OnMouseDown(b, "LeftButton")
      H.pressed = ${offsets}
      b.scripts.OnMouseUp(b, "LeftButton")
      b.scripts.OnClick(b, "LeftButton")
      b.scripts.OnMouseDown(b, "LeftButton")
      b.scripts.OnDragStart(b)
      b.scripts.OnUpdate(b, 0.1)
      b.scripts.OnDragStop(b)
      b.scripts.OnMouseUp(b, "LeftButton")
      b.scripts.OnMouseDown(b, "RightButton")
      b.scripts.OnMouseUp(b, "RightButton")
      b.scripts.OnClick(b, "RightButton")`);
    expect(await a.errors()).toEqual([]);
    expect(await a.json("H.pressed")).toEqual([start[0], start[1] + 1, start[2] - 1]);
    expect(await a.json(offsets)).toEqual(start);
    expect(await a.json("VigilMinimapButton.icon.texCoord == nil")).toBe(true);
  });

  it("migrates 0.2.x SavedVariables without losing snapshots or settings", async () => {
    const a = await load(
      "tbc",
      `{ version = 1, snapshots = { { at = 1, name = "Paladin", gear = {} } }, settings = { autoLog = true, autoLogInstances = false },
         minimap = { minimapPos = 90, hide = true }, machineExport = "{}" }`,
    );
    expect(await a.errors()).toEqual([]);
    const db = await a.json<Record<string, Record<string, unknown>>>("VigilDB");
    expect(db.version).toBe(2);
    expect(db.settings).toEqual({ autoLog: true, autoLogInstances: false });
    expect(db.minimap).toEqual({ minimapPos: 90, hide: true });
    expect(db.live).toMatchObject({ shown: true, locked: false, scale: 1 });
    expect(db.intel).toMatchObject({ enabled: true, collapsed: false });
    expect(db.callouts).toMatchObject({ enabled: true, idle: true, idleSeconds: 2.5, buffs: true });
    expect((db.snapshots as unknown as { at: number }[])[0]).toMatchObject({ at: 1, name: "Paladin" });
    expect(await a.json("VigilMinimapButton == nil or not VigilMinimapButton:IsShown()")).toBe(true);
  });

  describe("replaying the TBC Anniversary sample", () => {
    const events = fixtureEvents();

    it("finds the same fights, damage and DPS as the desktop engine", async () => {
      const live = new LiveSession({ fallbackYear: 2026 });
      for (const line of splitLines(text)) live.pushLine(line);
      live.finish();
      const desktop = live.drainCompleted().map((c) => c.report);

      const a = await load("tbc");
      await a.replay(events);
      await a.wait(10);
      expect(await a.errors()).toEqual([]);
      const fights = await a.json<FightSummary[]>("H.ns.fight.history");

      expect(fights.map((f) => [f.label, f.kind, f.damage])).toEqual(desktop.map((r) => [r.fight.label, r.fight.kind, r.totals.damage]));
      for (const [i, f] of fights.entries()) {
        const r = desktop[i]!;
        expect(f.duration).toBeCloseTo(r.fight.durationMs / 1000, 1);
        expect(Math.abs(f.playerDps - r.totals.dps) / r.totals.dps).toBeLessThan(0.02);
        expect(f.petDamage).toBe(0);
        expect(Math.abs(f.active * 1000 - r.activity.activeMs)).toBeLessThan(60);
        const desktopIdle = r.activity.idleGaps.reduce((sum, [x, y]) => sum + (y - x), 0);
        expect(Math.abs(f.idle * 1000 - desktopIdle)).toBeLessThan(60);
      }
      const saved = await a.json<FightSummary[]>("VigilDB.fights");
      expect(saved.map((f) => f.label)).toEqual(fights.map((f) => f.label));
    });

    it("shows the fight live in the panel and the minimap tooltip, then the summary", async () => {
      const a = await load("tbc");
      const firstFight = events.findIndex((e) => e.type === "SWING_DAMAGE" && e.src?.guid === PALADIN);
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.run("H.inCombat = true");
      await a.replay(events.slice(0, firstFight + 40));
      await a.wait(0.3);
      expect(await a.json("VigilLivePanel:IsShown()")).toBe(true);
      expect(await a.json("VigilLivePanel.title:GetText()")).toMatch(/^Talbuk Stag/);
      const rows = await a.json<string[]>(`(function() local t = {} for i = 1, 4 do t[i] = VigilLivePanel.rows[i].label:GetText() .. "=" .. VigilLivePanel.rows[i].value:GetText() end return t end)()`);
      expect(rows[0]).toMatch(/^Time=0:\d\d$/);
      expect(rows[2]).toMatch(/^DPS=\d+\.\dK?$/);
      await a.run("VigilMinimapButton.scripts.OnEnter(VigilMinimapButton)");
      expect((await a.json<string[]>("GameTooltip.lines")).some((l) => l.startsWith("DPS | "))).toBe(true);
      const height = await a.json<number>("VigilLivePanel:GetHeight()");
      expect(height).toBeGreaterThan(80);

      await a.run("H.inCombat = false");
      await a.fire("PLAYER_REGEN_ENABLED");
      await a.wait(0.5);
      expect(await a.json("VigilLivePanel.subtitle:GetText()")).toBe("Last fight");
      expect(await a.errors()).toEqual([]);
    });

    it("allocates nothing per combat event", async () => {
      const a = await load("tbc");
      await a.replay(events.slice(0, 60));
      const growth = await a.json<Record<string, number>>(`(function()
        local rows = {
          table.pack(${T0}, "SPELL_DAMAGE", false, "Player-1-2", "Other", 0x514, 0, "Creature-0-1-1-1-17130-0001", "Talbuk Stag", 0xa48, 0, 35395, "Crusader Strike", 1, 100, -1, 1),
          table.pack(${T0}, "SWING_DAMAGE", false, ${lua(PALADIN)}, "Paladin", 0x511, 0, "Creature-0-6259-530-120-17130-00003B1769", "Talbuk Stag", 0xa48, 0, 400, -1, 1),
        }
        local out = {}
        local handler = H.ns.fight.onCombatLogEvent
        for i, r in ipairs(rows) do
          H.row = r
          r[1] = H.epoch + H.now
          handler("COMBAT_LOG_EVENT_UNFILTERED")
          collectgarbage("collect")
          collectgarbage("stop")
          local before = collectgarbage("count")
          for _ = 1, 20000 do handler("COMBAT_LOG_EVENT_UNFILTERED") end
          out[i == 1 and "ignored" or "counted"] = collectgarbage("count") - before
          collectgarbage("restart")
        end
        return out
      end)()`);
      expect(growth.ignored).toBeLessThan(1);
      expect(growth.counted).toBeLessThan(1);
      expect(await a.errors()).toEqual([]);
    });
  });

  describe("boss intel", () => {
    it("recognises a targeted boss by NPC ID, and by name when the ID is unknown", async () => {
      const a = await load("era");
      await a.run(`H.target("Creature-0-6259-409-120-12118-0000AAAA", "Lucifron")`);
      expect(await a.json("H.ns.intel.current.k")).toBe("lucifron");
      expect(await a.json("VigilIntelPanel:IsShown()")).toBe(true);
      expect(await a.json("VigilIntelPanel.title:GetText()")).toBe("Lucifron");
      expect(await a.json("VigilIntelPanel.subtitle:GetText()")).toBe("Molten Core");
      expect(await a.json("VigilIntelPanel.rows[1].name:GetText()")).toBe("Impending Doom");
      expect(await a.json("VigilIntelPanel.rows[1].icon:GetTexture()")).toBe(100000 + 19702);
      expect(await a.json("VigilIntelPanel.portrait.portrait")).toBe("target");

      await a.run(`H.target("Creature-0-6259-409-120-99999-0000BBBB", "Magmadar")`);
      expect(await a.json("H.ns.intel.current.k")).toBe("magmadar");

      await a.run(`VigilIntelPanel.collapse:Click()`);
      expect(await a.json("VigilIntelPanel.rows[1]:IsShown()")).toBe(false);
      const collapsed = await a.json<number>("VigilIntelPanel:GetHeight()");
      await a.run(`VigilIntelPanel.collapse:Click()`);
      expect(await a.json<number>("VigilIntelPanel:GetHeight()")).toBeGreaterThan(collapsed + 60);

      await a.run(`H.target(nil)`);
      await a.wait(10);
      expect(await a.json("VigilIntelPanel:IsShown()")).toBe(false);
      expect(await a.errors()).toEqual([]);
    });

    it("picks up a boss from the fight's combat events and names the fight after it", async () => {
      const a = await load("tbc");
      const boss = mob(11982, "Magmadar");
      await a.run(`H.epoch = ${T0} - H.now - 1`);
      await a.run([swing(1, ME, boss, 900), swing(2, boss, ME, 1200), swing(4, ME, boss, 950)].join("\n"));
      expect(await a.json("H.ns.intel.current.k")).toBe("magmadar");
      await a.wait(8);
      const [fight] = await a.json<FightSummary[]>("H.ns.fight.history");
      expect(fight).toMatchObject({ label: "Magmadar", boss: "magmadar", damage: 1850, taken: 1200, kind: "trash" });
    });

    it("bounds a boss fight by ENCOUNTER_START and ENCOUNTER_END", async () => {
      const a = await load("tbc");
      const boss = mob(12118, "Lucifron");
      await a.run(`H.epoch = ${T0} - H.now - 1`);
      await a.run(`H.at(${T0 + 1}) H.fire("ENCOUNTER_START", 663, "Lucifron", 9, 40)`);
      await a.run([swing(2, ME, boss, 1000), swing(20, ME, boss, 1000)].join("\n"));
      await a.run(`H.at(${T0 + 40}) H.fire("ENCOUNTER_END", 663, "Lucifron", 9, 40, 1)`);
      const [fight] = await a.json<FightSummary[]>("H.ns.fight.history");
      expect(fight).toMatchObject({ label: "Lucifron", kind: "boss", boss: "lucifron", damage: 2000 });
      expect(fight!.duration).toBeCloseTo(39, 0);
    });

    it("looks bosses up with /vigil intel", async () => {
      const a = await load("era");
      await a.run(`SlashCmdList.VIGIL("intel vancleef")`);
      expect(await a.json("H.ns.intel.current.n")).toBe("Edwin VanCleef");
      expect(await a.json("H.ns.intel.source")).toBe("lookup");
      expect(await a.json("VigilIntelPanel:IsShown()")).toBe(true);
      await a.run(`SlashCmdList.VIGIL("intel brd emperor")`);
      expect(await a.json("H.ns.intel.current.n")).toBe("Emperor Dagran Thaurissan");
      await a.run(`SlashCmdList.VIGIL("intel no such boss")`);
      expect((await a.chat()).at(-1)).toMatch(/no boss matches/);
      await a.run(`VigilIntelPanel.scripts.OnHide = nil H.target("Creature-0-6259-409-120-12118-0000AAAA", "Lucifron")`);
      expect(await a.json("H.ns.intel.current.n")).toBe("Emperor Dagran Thaurissan");
      expect(await a.errors()).toEqual([]);
    });
  });

  describe("callouts", () => {
    it("warns about idle time while fighting a live target, then shows the gap's length", async () => {
      const a = await load("tbc");
      const target = mob(17130, "Talbuk Stag");
      await a.run(`H.epoch = ${T0} - H.now - 1 H.inCombat = true`);
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.run(`H.target("Creature-0-6259-409-120-17130-0000AAAA", "Talbuk Stag")`);
      await a.run([cast(1, target, 35395, "Crusader Strike"), swing(1.1, ME, target, 400)].join("\n"));
      // Busy until 2.5 s (one 1.5 s global cooldown); the default warning comes at 2.5 s idle.
      await a.run(`H.at(${T0 + 4.5})`);
      expect(await a.json("VigilLivePanel.callout:GetText()")).toBe("");
      await a.run(`H.at(${T0 + 5.3})`);
      expect(await a.json("VigilLivePanel.callout:GetText()")).toMatch(/^Idle for 2\.\d s$/);
      await a.run([swing(5.4, target, ME, 100), cast(5.5, target, 35395, "Crusader Strike")].join("\n"));
      await a.wait(0.3);
      expect(await a.json("VigilLivePanel.callout:GetText()")).toBe("Idle for 3.0 s");
      // The finished gap lingers 4 s; by then a new one (busy until 7.0 s) is running.
      await a.wait(4.2);
      expect(await a.json("VigilLivePanel.callout:GetText()")).toMatch(/^Idle for 3\.\d s$/);

      await a.run(`VigilDB.callouts.idle = false`);
      await a.run(`H.at(${T0 + 11})`);
      expect(await a.json("VigilLivePanel.callout:GetText()")).toBe("");
      expect(await a.errors()).toEqual([]);
    });

    it("notices a self-buff from the pull going missing, and not one swapped within its group", async () => {
      const a = await load("tbc");
      const target = mob(17130, "Talbuk Stag");
      await a.run(`H.epoch = ${T0} - H.now - 1 H.inCombat = true H.buffs = { "Seal of Command", "Devotion Aura" }`);
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.run(
        [
          swing(1, ME, target, 400),
          cast(1.5, target, 20271, "Judgement"),
          aura(1.5, "SPELL_AURA_REMOVED", 20375, "Seal of Command"),
          aura(2, "SPELL_AURA_APPLIED", 21084, "Seal of Righteousness"),
          aura(2.5, "SPELL_AURA_REMOVED", 465, "Devotion Aura"),
          swing(3, ME, target, 400),
          swing(5, ME, target, 400),
          swing(6.5, ME, target, 400),
        ].join("\n"),
      );
      await a.wait(0.3);
      expect(await a.json("VigilLivePanel.callout:GetText()")).toMatch(/^No paladin aura for 4 s/);
      expect(await a.json("VigilLivePanel.callout:GetText()")).not.toMatch(/Seal/);
      await a.run(aura(7, "SPELL_AURA_APPLIED", 7294, "Retribution Aura"));
      await a.wait(0.3);
      expect(await a.json("VigilLivePanel.callout:GetText()")).not.toMatch(/aura/);
      expect(await a.errors()).toEqual([]);
    });
  });

  describe("Forever beta (12.x addon rules)", () => {
    /** A Forever-like client that offers combat events as far as the up-front check can tell. */
    const OPEN_LOG = `
      function CombatLogGetCurrentEventInfo() return unpack(H.row, 1, H.row.n) end
      C_CombatLog = { IsCombatLogRestricted = function() return false end }
      H.forbidden.COMBAT_LOG_EVENT_UNFILTERED = nil`;

    it("never registers for combat events and shows the game's damage meter instead", async () => {
      const a = await load("forever");
      expect(await a.json("#H.blocked")).toBe(0);
      expect(await a.json("H.events.COMBAT_LOG_EVENT_UNFILTERED == nil")).toBe(true);
      expect(await a.json("H.ns.fight.source()")).toBe("meter");
      expect(await a.json("VigilLivePanel.subtitle:GetText()")).toBe("Waiting for a fight");

      await a.run(`H.inCombat = true H.meter.damage = 12345 H.meter.dps = 1234.5 H.meter.duration = 10`);
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.fire("DAMAGE_METER_CURRENT_SESSION_UPDATED");
      await a.wait(0.3);
      // In combat the amounts are secret: shown through AbbreviateNumbers with Vigil's breakpoints, never compared.
      expect(await a.json("H.isSecret(VigilLivePanel.rows[2].value:GetText())")).toBe(true);
      expect(await panelRows(a)).toEqual(["Time=0:10", "Damage=12.3K", "DPS=1.2K"]);
      expect(await a.json("VigilLivePanel.subtitle:GetText()")).toBe("In combat");
      expect(await a.json("VigilLivePanel.note:GetText()")).toBe("Numbers from the game's damage meter.");
      await a.run(`VigilMinimapButton.scripts.OnEnter(VigilMinimapButton)`);
      expect((await a.json<string[]>("GameTooltip.lines")).some((l) => /^In combat \| 0:0\d$/.test(l))).toBe(true);

      await a.run(`H.meter.healing = 5000 H.meter.hps = 500`);
      await a.fire("DAMAGE_METER_COMBAT_SESSION_UPDATED", 2, 1);
      await a.wait(0.3);
      expect(await panelRows(a)).toEqual(["Time=0:10", "Damage=12.3K", "DPS=1.2K", "Healing=5000", "HPS=500"]);

      // Out of combat the meter reads as plain numbers.
      await a.run(`H.inCombat = false`);
      await a.fire("PLAYER_REGEN_ENABLED");
      await a.wait(0.3);
      expect(await panelRows(a)).toEqual(["Time=0:10", "Damage=12.3K", "DPS=1.2K", "Healing=5000", "HPS=500.0"]);
      expect(await a.json("VigilLivePanel.subtitle:GetText()")).toBe("Last fight");
      await a.run(`VigilMinimapButton.scripts.OnEnter(VigilMinimapButton) SlashCmdList.VIGIL("status") SlashCmdList.VIGIL("")`);
      expect(await a.json<string[]>("GameTooltip.lines")).toContain("Last fight | 1.2K DPS");
      expect((await a.chat()).some((l) => l.includes("from the game's damage meter"))).toBe(true);
      expect(await a.json("VigilPanel.calloutNote:GetText()")).toMatch(/idle warning is off/);
      expect(await a.json("#H.ns.fight.history + #VigilDB.fights")).toBe(0);
      expect(await a.errors()).toEqual([]);
    });

    it("rounds the meter's DPS in and out of combat", async () => {
      const a = await load("forever");
      await a.run(`H.inCombat = true H.meter.damage = 203 H.meter.dps = 10.68421052636 H.meter.duration = 19`);
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.wait(0.3);
      // Blizzard's own call (AbbreviateLargeNumbers) would show "10.68421052636"; Vigil's breakpoints truncate.
      expect(await a.json("H.plain(AbbreviateLargeNumbers(H.secret(10.68421052636)))")).toBe("10.68421052636");
      expect(await a.json("H.isSecret(VigilLivePanel.rows[3].value:GetText())")).toBe(true);
      expect(await panelRows(a)).toEqual(["Time=0:19", "Damage=203", "DPS=10.6"]);

      await a.run(`H.inCombat = false`);
      await a.fire("PLAYER_REGEN_ENABLED");
      await a.wait(0.3);
      expect(await panelRows(a)).toEqual(["Time=0:19", "Damage=203", "DPS=10.7"]);
      await a.run(`VigilMinimapButton.scripts.OnEnter(VigilMinimapButton)`);
      expect(await a.json<string[]>("GameTooltip.lines")).toContain("Last fight | 10.7 DPS");
      expect(await a.errors()).toEqual([]);
    });

    it("falls back to string.format for a secret DPS when the client refuses Vigil's breakpoints", async () => {
      const a = await load("forever", undefined, `
        local abbreviate = AbbreviateNumbers
        AbbreviateNumbers = function(n, options) if options then error("invalid breakpoints") end return abbreviate(n) end`);
      await a.run(`H.inCombat = true H.meter.damage = 12345 H.meter.dps = 10.68421052636 H.meter.duration = 10`);
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.wait(0.3);
      expect(await a.json("H.isSecret(VigilLivePanel.rows[3].value:GetText())")).toBe(true);
      expect(await panelRows(a)).toEqual(["Time=0:10", "Damage=12K", "DPS=10.7"]);
      expect(await a.errors()).toEqual([]);
    });

    it("says so when the game's damage meter is switched off", async () => {
      const a = await load("forever", undefined, "H.meterSwitchedOff = true");
      await a.run("H.inCombat = true");
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.wait(2.1);
      expect(await panelRows(a)).toEqual(["Time=0:02"]);
      expect(await a.json("VigilLivePanel.note:GetText()")).toMatch(/Turn on the game's damage meter/);
      expect(await a.errors()).toEqual([]);
    });

    it("recognises a boss by name when its GUID is secret, and from ENCOUNTER_START when both are", async () => {
      const a = await load("forever");
      await a.run(`H.target("Creature-0-6259-409-120-12118-0000AAAA", "Lucifron")`);
      expect(await a.json("H.isSecret(UnitGUID('target'))")).toBe(true);
      expect(await a.json("H.ns.intel.current.k")).toBe("lucifron");
      expect(await a.json("VigilIntelPanel.title:GetText()")).toBe("Lucifron");
      await a.run(`SlashCmdList.VIGIL("intel")`);
      expect(await a.json("H.ns.intel.source")).toBe("lookup");
      await a.run(`H.ns.intel.close() H.target(nil)`);
      await a.wait(10);

      await a.run(`H.namesSecret = true H.target("Creature-0-6259-409-120-11982-0000BBBB", "Magmadar")`);
      expect(await a.json("H.ns.intel.current == nil")).toBe(true);
      await a.run(`H.inCombat = true H.meter.damage = 900 H.meter.dps = 90`);
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.fire("ENCOUNTER_START", 664, "Magmadar", 9, 40);
      await a.wait(70);
      expect(await a.json("H.ns.intel.current.k")).toBe("magmadar");
      expect(await a.json("H.ns.intel.source")).toBe("encounter");
      // The encounter names the panel for its whole length: no combat events to time it out.
      expect(await a.json("VigilLivePanel.title:GetText()")).toBe("Magmadar");
      expect(await a.json("VigilLivePanel.subtitle:GetText()")).toBe("Molten Core");
      await a.fire("ENCOUNTER_END", 664, "Magmadar", 9, 40, 1);
      await a.run(`H.inCombat = false`);
      await a.fire("PLAYER_REGEN_ENABLED");
      expect(await a.json("#VigilDB.fights")).toBe(0);

      // Secret encounter payloads are dropped without an error.
      await a.run(`H.fire("ENCOUNTER_START", H.secret(663), H.secret("Lucifron"), 9, 40) H.fire("ENCOUNTER_END", H.secret(663), H.secret("Lucifron"), 9, 40, 1)`);
      await a.run(`H.target("Creature-0-6259-409-120-12118-0000AAAA", "Lucifron") SlashCmdList.VIGIL("intel lucifron")`);
      expect(await a.json("H.ns.intel.current.k")).toBe("lucifron");
      expect(await a.errors()).toEqual([]);
    });

    it("keeps the dropped-buff callout while buffs are readable, and goes quiet when they are secret", async () => {
      const a = await load("forever");
      await a.run(`H.buffs = { "Seal of Command", "Devotion Aura" } H.inCombat = true H.meter.damage = 100 H.meter.dps = 10`);
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.wait(1);
      await a.run(`H.buffs = { "Seal of Righteousness" }`);
      await a.wait(3.5);
      expect(await a.json("VigilLivePanel.callout:GetText()")).toMatch(/^No paladin aura for 3 s$/);
      await a.run(`H.aurasSecret = true`);
      await a.wait(0.5);
      expect(await a.json("VigilLivePanel.callout:GetText()")).toBe("");
      await a.run(`H.inCombat = false`);
      await a.fire("PLAYER_REGEN_ENABLED");
      await a.run(`SlashCmdList.VIGIL("snapshot")`);
      expect((await a.chat()).at(-1)).toMatch(/snapshot saved|nothing changed/);
      expect(await a.errors()).toEqual([]);
    });

    it("switches to the damage meter after a combat without a single combat event", async () => {
      const a = await load("forever", undefined, OPEN_LOG);
      expect(await a.json("H.ns.fight.available")).toBe(null);
      expect(await a.json("#H.events.COMBAT_LOG_EVENT_UNFILTERED")).toBe(1);
      await a.run(`H.inCombat = true H.meter.damage = 500 H.meter.dps = 50`);
      await a.fire("PLAYER_REGEN_DISABLED");
      await a.wait(5);
      await a.run(`H.inCombat = false`);
      await a.fire("PLAYER_REGEN_ENABLED");
      expect(await a.json("H.ns.fight.available")).toBe(false);
      expect(await a.json("H.events.COMBAT_LOG_EVENT_UNFILTERED[1] == nil")).toBe(true);
      await a.wait(0.3);
      expect(await a.json("VigilLivePanel.note:GetText()")).toBe("Numbers from the game's damage meter.");
      expect(await a.errors()).toEqual([]);
    });

    it("switches over when registering is refused with a blocked-action event instead of an error", async () => {
      const a = await load("forever", undefined, `function CombatLogGetCurrentEventInfo() return unpack(H.row, 1, H.row.n) end C_CombatLog = nil`);
      expect(await a.json("H.blocked")).toEqual(["COMBAT_LOG_EVENT_UNFILTERED"]);
      expect(await a.json("H.ns.fight.available")).toBe(false);
      expect(await a.json("H.ns.fight.source()")).toBe("meter");
      expect(await a.errors()).toEqual([]);
    });

    it("switches live tracking off when the client hands out secret combat events", async () => {
      const a = await load("forever", undefined, `${OPEN_LOG}
        local s = H.secret(1)
        function CombatLogGetCurrentEventInfo() return s, s, false, s end`);
      expect(await a.json("H.ns.fight.available")).toBe(null);
      await a.run(`H.fire("COMBAT_LOG_EVENT_UNFILTERED") H.fire("COMBAT_LOG_EVENT_UNFILTERED")`);
      expect(await a.json("H.ns.fight.available")).toBe(false);
      expect(await a.json("H.events.COMBAT_LOG_EVENT_UNFILTERED[1] == nil")).toBe(true);
      expect(await a.errors()).toEqual([]);
    });
  });

  it("keeps working on a client that restricts combat events", async () => {
    const a = await load("retail");
    await a.run("H.inCombat = true");
    await a.fire("PLAYER_REGEN_DISABLED");
    await a.run(`H.target("Creature-0-6259-409-120-12118-0000AAAA", "Lucifron")`);
    await a.wait(1);
    expect(await a.json("VigilLivePanel.note:GetText()")).toMatch(/keeps combat events from addons/);
    expect(await a.json("VigilIntelPanel.title:GetText()")).toBe("Lucifron");
    expect(await a.json("VigilIntelPanel.rows[1].icon:GetTexture()")).toBe(200000 + 19702);
    await a.run("H.inCombat = false");
    await a.fire("PLAYER_REGEN_ENABLED");
    await a.wait(1);
    expect(await a.errors()).toEqual([]);
  });
});
