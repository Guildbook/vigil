import { readFileSync } from "node:fs";
import path from "node:path";
import { LuaFactory, type LuaEngine } from "wasmoon";
import type { CombatEvent } from "@/lib/combatlog/types";

/**
 * Runs the bundled Vigil addon in a Lua VM (wasmoon, Lua 5.4 with 5.1 shims) against a mocked WoW client: frames,
 * events, timers on a virtual clock, units, and COMBAT_LOG_EVENT_UNFILTERED rows built from parsed log events.
 * Values cross into Lua as generated source, never as JS values, so nil stays nil.
 */

export const ADDON_DIR = path.resolve(__dirname, "..", "resources", "addon", "Vigil");

/** "forever": the Forever beta on the 12.x addon rules (no combat events, secret values, the game's damage meter). */
export type Flavor = "era" | "tbc" | "retail" | "forever";

export interface HarnessOptions {
  flavor?: Flavor;
  /** A Lua expression for VigilDB as saved by an earlier version. */
  savedVariables?: string;
  player?: { guid: string; name: string; className?: string };
  /** Lua run after the flavor's mock and before the addon loads, to vary a client. */
  setup?: string;
}

const MOCK = String.raw`
local H = { now = 1000, epoch = 1700000000, timers = {}, events = {}, chat = {}, errors = {}, frames = 0,
  units = {}, buffs = {}, forbidden = {}, blocked = {}, logging = false, inCombat = false }
_G.H = H

-- Secret values (12.x): storing and passing them is fine; comparing, arithmetic, indexing, length and string
-- methods raise errors, as in the client. Concatenation yields another secret.
local function secretError() error("attempt to use a secret value", 2) end
local Secret = {
  __index = secretError, __newindex = secretError, __len = secretError, __call = secretError,
  __eq = secretError, __lt = secretError, __le = secretError, __unm = secretError,
  __add = secretError, __sub = secretError, __mul = secretError, __div = secretError, __mod = secretError,
  __pow = secretError, __idiv = secretError,
  __concat = function(a, b) return H.secret(tostring(H.plain(a)) .. tostring(H.plain(b))) end,
}
function H.secret(v) return setmetatable({ [Secret] = v }, Secret) end
function H.isSecret(v) return type(v) == "table" and getmetatable(v) == Secret end
function H.plain(v) if H.isSecret(v) then return rawget(v, Secret) end return v end

unpack = unpack or table.unpack
bit = { band = function(a, b) return math.floor(a) & math.floor(b) end, bor = function(a, b) return math.floor(a) | math.floor(b) end }
function strtrim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
function wipe(t) for k in pairs(t) do t[k] = nil end return t end
tinsert = table.insert

function H.call(fn, ...)
  local ok, err = xpcall(fn, debug.traceback, ...)
  if not ok then table.insert(H.errors, tostring(err)) end
  return ok
end

-- Timers on a virtual clock -------------------------------------------------
function GetTime() return H.now end
function time() return math.floor(H.epoch + H.now) end
C_Timer = {
  After = function(delay, fn) table.insert(H.timers, { at = H.now + delay, fn = fn }) end,
  NewTicker = function(delay, fn)
    local t = { at = H.now + delay, fn = fn, every = delay }
    function t:Cancel() self.cancelled = true end
    table.insert(H.timers, t)
    return t
  end,
}
function H.advance(to)
  while true do
    local best, index
    for i, t in ipairs(H.timers) do
      if not t.cancelled and t.at <= to and (not best or t.at < best.at) then best, index = t, i end
    end
    if not best then break end
    if best.at > H.now then H.now = best.at end
    if best.every then best.at = best.at + best.every else table.remove(H.timers, index) end
    H.call(best.fn)
  end
  if to > H.now then H.now = to end
end
function H.wait(seconds) H.advance(H.now + seconds) end

-- Frames --------------------------------------------------------------------
local M = {}
local function noop() end
local Region = { __index = function(self, key)
  local m = M[key]
  if m then return m end
  if type(key) == "string" and key:match("^%u") then return noop end
end }

local function new(kind, name, parent)
  H.frames = H.frames + 1
  local r = setmetatable({ kind = kind, name = name, parent = parent, scripts = {}, points = {}, shown = true,
    w = 0, h = 0, scale = 1, id = H.frames }, Region)
  if name then _G[name] = r end
  return r
end
H.new = new

function M:SetScript(name, fn) self.scripts[name] = fn end
function M:GetScript(name) return self.scripts[name] end
function M:HookScript(name, fn)
  local old = self.scripts[name]
  self.scripts[name] = function(...) if old then old(...) end fn(...) end
end
function M:RegisterEvent(event)
  -- "silent": the 12.x engine's way, no Lua error but a blocked-action event (and popup) naming the addon.
  if H.forbidden[event] == "silent" then
    H.blocked[#H.blocked + 1] = event
    H.fire("ADDON_ACTION_FORBIDDEN", "Vigil", "RegisterEvent")
    return
  end
  if H.forbidden[event] then error("Frame:RegisterEvent(): " .. event .. " is restricted") end
  H.events[event] = H.events[event] or {}
  for _, f in ipairs(H.events[event]) do if f == self then return end end
  table.insert(H.events[event], self)
end
function M:UnregisterEvent(event)
  for i, f in ipairs(H.events[event] or {}) do if f == self then table.remove(H.events[event], i) return end end
end
function M:Show()
  local was = self.shown
  self.shown = true
  if not was and self.scripts.OnShow then H.call(self.scripts.OnShow, self) end
end
function M:Hide()
  local was = self.shown
  self.shown = false
  if was and self.scripts.OnHide then H.call(self.scripts.OnHide, self) end
end
function M:IsShown() return self.shown end
function M:IsVisible() return self.shown and (not self.parent or self.parent == UIParent or self.parent:IsVisible()) end
function M:SetShown(v) if v then self:Show() else self:Hide() end end
function M:SetSize(w, h) self.w, self.h = w, h end
function M:SetWidth(w) self.w = w end
function M:SetHeight(h) self.h = h end
function M:GetWidth() return self.w end
function M:GetHeight() return self.h end
function M:GetSize() return self.w, self.h end
function M:SetScale(s) self.scale = s end
function M:GetScale() return self.scale end
function M:GetEffectiveScale() return self.scale end
function M:SetPoint(point, a, b, c, d)
  if type(a) == "number" or a == nil then
    table.insert(self.points, { point, nil, point, a or 0, b or 0 })
  else
    table.insert(self.points, { point, a, b or point, c or 0, d or 0 })
  end
end
function M:ClearAllPoints() self.points = {} end
function M:GetPoint(i)
  local p = self.points[i or 1]
  if p then return p[1], p[2], p[3], p[4], p[5] end
end
function M:GetCenter() return 900, 500 end
function M:GetFrameLevel() return 1 end
function M:GetParent() return self.parent end
function M:GetName() return self.name end
function M:EnableMouse(v) self.mouse = v end
function M:CreateTexture() return new("Texture", nil, self) end
function M:CreateFontString() return new("FontString", nil, self) end
function M:CreateAnimationGroup() return new("AnimationGroup", nil, self) end
function M:CreateAnimation() return new("Animation", nil, self) end
function M:SetTexture(t) self.texture = t end
-- Masks as on modern clients: once a texture has one, its coordinates are fixed and SetTexCoord raises an error.
function M:SetTexCoord(...) if self.masked then error("Texture:SetTexCoord(): Cannot set tex coords when texture has mask.", 2) end self.texCoord = { ... } end
function M:SetMask(path) self.masked = path ~= nil and path ~= "" end
function M:AddMaskTexture() self.masked = true end
function M:GetNumMaskTextures() return self.masked and 1 or 0 end
function M:GetTexture() return self.texture end
function M:SetText(t) self.text = t end
function M:GetText() return self.text end
--- What the player sees: the plain text, or the text behind a secret.
function M:Shown() return H.plain(self.text) end
function M:GetFont() return "Fonts\\FRIZQT__.TTF", 12 end
function M:GetStringWidth() return #tostring(H.plain(self.text) or "") * 6 end
--- Wraps at about 6 px per character inside the explicit width, so layout code sees multi-line text.
function M:GetStringHeight()
  local text = tostring(H.plain(self.text) or "")
  if text == "" then return 0 end
  local perLine = math.max(1, math.floor((self.w > 0 and self.w or 200) / 6))
  local lines = 0
  for part in (text .. "\n"):gmatch("(.-)\n") do lines = lines + math.max(1, math.ceil(#part / perLine)) end
  return lines * 12
end
function M:SetChecked(v) self.checked = v and true or false end
function M:GetChecked() return self.checked end
function M:Enable() self.enabled = true end
function M:Disable() self.enabled = false end
function M:SetOwner(owner) self.owner = owner; self.lines = {} end
function M:IsOwned(owner) return self.owner == owner and self.shown end
function M:AddLine(text) table.insert(self.lines, tostring(text)) end
function M:AddDoubleLine(a, b) table.insert(self.lines, tostring(a) .. " | " .. tostring(b)) end
function M:AddMessage(text) table.insert(H.chat, text) end
function M:Click(button) if self.scripts.OnClick then H.call(self.scripts.OnClick, self, button or "LeftButton") end end

function CreateFrame(kind, name, parent) return new(kind, name, parent) end
UIParent = new("Frame", "UIParent")
UIParent.w, UIParent.h = 1920, 1080
Minimap = new("Frame", "Minimap", UIParent)
Minimap.w, Minimap.h = 140, 140
GameTooltip = new("GameTooltip", "GameTooltip", UIParent)
GameTooltip.lines = {}
GameTooltip.shown = false
DEFAULT_CHAT_FRAME = new("Frame", "ChatFrame1", UIParent)
ChatFontNormal = {}
UISpecialFrames = {}
SlashCmdList = {}
function hooksecurefunc(t, key, fn)
  local old = t[key]
  t[key] = function(...) local r = { old(...) } fn(...) return unpack(r) end
end

function H.fire(event, ...)
  local list = H.events[event]
  if not list then return end
  for _, f in ipairs({ unpack(list) }) do
    if f.scripts.OnEvent then H.call(f.scripts.OnEvent, f, event, ...) end
  end
end

-- Units, auras, logging -------------------------------------------------------
function UnitGUID(u) return H.units[u] and H.units[u].guid end
function UnitName(u) return H.units[u] and H.units[u].name end
function UnitExists(u) return H.units[u] ~= nil end
function UnitIsPlayer(u) return H.units[u] ~= nil and H.units[u].player == true end
function UnitCanAttack(_, u) return H.units[u] ~= nil and H.units[u].hostile == true end
function UnitIsDead(u) return H.units[u] ~= nil and H.units[u].dead == true end
function UnitIsFeignDeath() return false end
function UnitAffectingCombat() return H.inCombat end
function InCombatLockdown() return H.inCombat end
function UnitClass(u) local x = H.units[u] return x and x.className, x and x.classFile end
function UnitRace() return "Human", "Human" end
function UnitLevel() return 70 end
function UnitFullName(u) return UnitName(u), "Dreamscythe" end
function UnitCastingInfo() return nil end
function UnitChannelInfo() return nil end
function IsInInstance() return false, "none" end
function GetInstanceInfo() return "Nagrand" end
function GetRealZoneText() return "Nagrand" end
H.cvars = {}
function GetCVar(name) local v = H.cvars[name] if v ~= nil then return v end return "1" end
function SetCVar(name, value)
  if H.cvarsLocked then error("SetCVar blocked") end
  H.cvars[name] = tostring(value)
  return true
end
function GetCursorPosition() return 0, 0 end
function SetPortraitTexture(tex, unit) tex.portrait = unit; tex.texture = "portrait:" .. unit end
function LoggingCombat(...)
  if select("#", ...) == 0 then return H.logging end
  H.logging = (...) and true or false
  return H.logging
end
function CombatLogGetCurrentEventInfo() return unpack(H.row, 1, H.row.n) end

function H.cleu(...)
  local row = table.pack(...)
  H.advance(row[1] - H.epoch)
  H.row = row
  H.fire("COMBAT_LOG_EVENT_UNFILTERED")
end

function H.at(ts) H.advance(ts - H.epoch) end

function H.target(guid, name, hostile)
  if guid then
    H.units.target = { guid = guid, name = name, hostile = hostile ~= false, player = guid:find("^Player") ~= nil }
  else
    H.units.target = nil
  end
  H.fire("PLAYER_TARGET_CHANGED")
end

function H.loadFile(name, source)
  local fn, err = load(source, "@" .. name)
  if not fn then error(err) end
  local ok, e = xpcall(fn, debug.traceback, "Vigil", H.ns)
  if not ok then error(name .. ": " .. tostring(e)) end
end
H.ns = {}
`;

const FLAVORS: Record<Flavor, string> = {
  era: String.raw`
    function GetBuildInfo() return "1.15.8", "65000", "Jan 1 2026", 11508 end
    WOW_PROJECT_ID, WOW_PROJECT_MAINLINE = 2, 1
    BackdropTemplateMixin = {}
    function GetSpellTexture(id) return 100000 + id end
    function GetSpellInfo(id) return nil end
    function UnitBuff(unit, i) local b = unit == "player" and H.buffs[i] if b then return b, 136000, 0, nil, 0, 0, "player", false, false, 1 end end
    Settings = { RegisterCanvasLayoutCategory = function(f, name) return { frame = f, name = name } end, RegisterAddOnCategory = function() end }
  `,
  tbc: String.raw`
    function GetBuildInfo() return "2.5.6", "66000", "Jan 1 2026", 20506 end
    WOW_PROJECT_ID, WOW_PROJECT_MAINLINE = 5, 1
    BackdropTemplateMixin = {}
    function GetSpellTexture(id) return 100000 + id end
    function GetSpellInfo(id) return nil end
    function UnitBuff(unit, i) local b = unit == "player" and H.buffs[i] if b then return b, 136000, 0, nil, 0, 0, "player", false, false, 1 end end
    function InterfaceOptions_AddCategory(frame) H.optionsCategory = frame end
  `,
  retail: String.raw`
    function GetBuildInfo() return "12.0.1", "67000", "Jan 1 2026", 120001 end
    WOW_PROJECT_ID, WOW_PROJECT_MAINLINE = 1, 1
    BackdropTemplateMixin = {}
    issecretvalue = H.isSecret
    C_Spell = { GetSpellTexture = function(id) return 200000 + id end, GetSpellInfo = function(id) return nil end }
    C_UnitAuras = { GetAuraDataByIndex = function(unit, i) local b = unit == "player" and H.buffs[i] if b then return { name = b, spellId = 1 } end end }
    CombatLogGetCurrentEventInfo = nil
    C_CombatLog = { GetCurrentEventInfo = function() return unpack(H.row, 1, H.row.n) end }
    H.forbidden.COMBAT_LOG_EVENT_UNFILTERED = true
    Settings = { RegisterCanvasLayoutCategory = function(f, name) return { frame = f, name = name } end, RegisterAddOnCategory = function() end }
  `,
  // The Forever beta (1.60.1.70009) on the 12.x addon rules, after Blizzard's generated API docs for that build.
  forever: String.raw`
    function GetBuildInfo() return "1.60.1", "70009", "Sep 24 2026", 16001 end
    WOW_PROJECT_ID, WOW_PROJECT_MAINLINE = 1, 1
    BackdropTemplateMixin = {}
    issecretvalue = H.isSecret
    function issecrettable(t) return false end
    function canaccesstable(t) return true end
    C_Spell = { GetSpellTexture = function(id) return 200000 + id end, GetSpellInfo = function(id) return nil end }
    -- H.aurasSecret: in-combat aura restrictions, where each aura comes back with secret fields.
    C_UnitAuras = { GetAuraDataByIndex = function(unit, i)
      local b = unit == "player" and H.buffs[i]
      if not b then return nil end
      if H.aurasSecret then return { name = H.secret(b), spellId = H.secret(1) } end
      return { name = b, spellId = 1 }
    end }
    Settings = { RegisterCanvasLayoutCategory = function(f, name) return { frame = f, name = name } end, RegisterAddOnCategory = function() end }

    -- Combat events: no reader, the log reported restricted, and registering is refused without a Lua error.
    CombatLogGetCurrentEventInfo = nil
    C_CombatLog = { IsCombatLogRestricted = function() return true end }
    H.forbidden.COMBAT_LOG_EVENT_UNFILTERED = "silent"

    -- Enemy GUIDs are secret; enemy names too while H.namesSecret is set. The player and players stay plain.
    local plainGUID, plainName = UnitGUID, UnitName
    local function restricted(u) return u ~= "player" and not (H.units[u] and H.units[u].player) end
    function UnitGUID(u) local v = plainGUID(u) if v and restricted(u) then return H.secret(v) end return v end
    function UnitName(u) local v = plainName(u) if v and restricted(u) and H.namesSecret then return H.secret(v) end return v end

    -- Formatters that accept secrets (SecretArguments = AllowedWhenTainted) and return secret text. Below the
    -- first breakpoint the number comes back as it is, unrounded ("10.68421052636"), as seen on the client.
    local DEFAULT_BREAKPOINTS = {
      { breakpoint = 10000000, abbreviation = "M", significandDivisor = 1000000, fractionDivisor = 1 },
      { breakpoint = 1000000, abbreviation = "M", significandDivisor = 100000, fractionDivisor = 10 },
      { breakpoint = 10000, abbreviation = "K", significandDivisor = 1000, fractionDivisor = 1 },
      { breakpoint = 1000, abbreviation = "K", significandDivisor = 100, fractionDivisor = 10 },
    }
    local function abbreviate(n, options)
      for _, b in ipairs(options and options.breakpointData or DEFAULT_BREAKPOINTS) do
        if n >= b.breakpoint then
          local value = math.floor(n / b.significandDivisor) / b.fractionDivisor
          if value == math.floor(value) then value = math.floor(value) end
          return tostring(value) .. b.abbreviation
        end
      end
      return tostring(n)
    end
    local function acceptsSecrets(fn)
      return function(n, ...)
        if H.isSecret(n) then return H.secret(fn(H.plain(n), ...)) end
        return fn(n, ...)
      end
    end
    AbbreviateNumbers = acceptsSecrets(abbreviate)
    AbbreviateLargeNumbers = acceptsSecrets(function(n) return abbreviate(n) end)
    BreakUpLargeNumbers = acceptsSecrets(function(n) return tostring(n) end)
    -- string.format takes secrets from tainted code and returns secret text.
    local plainFormat = string.format
    string.format = function(pattern, ...)
      local args, secret = table.pack(...), H.isSecret(pattern)
      for i = 1, args.n do
        if H.isSecret(args[i]) then args[i], secret = H.plain(args[i]), true end
      end
      local text = plainFormat(H.plain(pattern), unpack(args, 1, args.n))
      if secret then return H.secret(text) end
      return text
    end

    -- The game's damage meter: H.meter holds the current session; amounts are secret while H.inCombat.
    Enum = { DamageMeterSessionType = { Overall = 0, Current = 1, Expired = 2 },
      DamageMeterType = { DamageDone = 0, Dps = 1, HealingDone = 2, Hps = 3 } }
    H.meter = { damage = nil, dps = nil, healing = nil, hps = nil, duration = 0, available = true }
    local baseGetCVar = GetCVar
    function GetCVar(name) if name == "damageMeterEnabled" then return H.meterSwitchedOff and "0" or "1" end return baseGetCVar(name) end
    local function amount(v) if H.inCombat then return H.secret(v) end return v end
    C_DamageMeter = {
      IsDamageMeterAvailable = function() return H.meter.available, H.meter.available and "" or "Too low level" end,
      GetCombatSessionFromType = function(sessionType, meterType)
        H.meterCalls = (H.meterCalls or 0) + 1
        local m = H.meter
        local total, rate
        if meterType == Enum.DamageMeterType.DamageDone then total, rate = m.damage, m.dps
        elseif meterType == Enum.DamageMeterType.HealingDone then total, rate = m.healing, m.hps end
        local sources = {}
        if sessionType == Enum.DamageMeterSessionType.Current and total then
          sources[1] = { name = amount("Warrior"), classFilename = "WARRIOR", isLocalPlayer = false, totalAmount = amount(total * 2), amountPerSecond = amount(rate * 2) }
          sources[2] = { name = amount(UnitName("player")), classFilename = "PALADIN", isLocalPlayer = true, totalAmount = amount(total), amountPerSecond = amount(rate) }
        end
        return { combatSources = sources, maxAmount = amount(total and total * 2 or 0), totalAmount = amount(total and total * 3 or 0), durationSeconds = amount(m.duration) }
      end,
      GetSessionDurationSeconds = function(sessionType) return H.meter.duration end,
    }
  `,
};

/** A Lua literal for a JS value (strings, numbers, booleans; null and undefined are nil). */
export function lua(v: unknown): string {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

const EMPTY_GUID = "0000000000000000";

/** The arguments CombatLogGetCurrentEventInfo returns for a parsed log event, or null for file-only events. */
export function cleuArgs(ev: CombatEvent): unknown[] | null {
  const t = ev.type;
  if (t === "SWING_DAMAGE_LANDED" || t.startsWith("ENCOUNTER_") || t === "ZONE_CHANGE" || t === "MAP_CHANGE") return null;
  const unit = (u: CombatEvent["src"]) => (u && u.guid !== EMPTY_GUID ? [u.guid, u.name === "nil" ? null : u.name, u.flags, 0] : ["", null, 0x80000000, 0]);
  const args: unknown[] = [ev.t / 1000, t, false, ...unit(ev.src), ...unit(ev.dst)];
  if (t.startsWith("SPELL_") || t.startsWith("RANGE_") || t.startsWith("DAMAGE_")) args.push(ev.spellId, ev.spellName, ev.school);
  else if (t.startsWith("ENVIRONMENTAL_")) args.push("Falling");
  if (t.endsWith("_DAMAGE") || t === "DAMAGE_SHIELD" || t === "DAMAGE_SPLIT") {
    args.push(ev.amount ?? 0, ev.overkill ?? -1, ev.school ?? 1, ev.resisted ?? null, ev.blocked ?? null, ev.absorbed ?? null, ev.critical ?? false, false, false, ev.offHand ?? false);
  } else if (t.endsWith("_MISSED")) {
    args.push(ev.missType ?? "MISS", ev.offHand ?? false, ev.amount ?? null);
  } else if (t.endsWith("_HEAL")) {
    args.push(ev.amount ?? 0, ev.overheal ?? 0, ev.absorbed ?? 0, ev.critical ?? false);
  } else if (t.startsWith("SPELL_AURA_")) {
    args.push(ev.auraType ?? "BUFF", ev.stacks ?? null);
  } else if (t.endsWith("_ENERGIZE")) {
    args.push(ev.amount ?? 0, ev.overEnergize ?? 0, ev.powerType ?? 0);
  }
  return args;
}

export interface Addon {
  engine: LuaEngine;
  run(code: string): Promise<unknown>;
  /** Evaluates a Lua expression and returns it through the addon's own JSON writer. */
  json<T = unknown>(expr: string): Promise<T>;
  fire(event: string, ...args: unknown[]): Promise<void>;
  wait(seconds: number): Promise<void>;
  replay(events: CombatEvent[]): Promise<void>;
  errors(): Promise<string[]>;
  chat(): Promise<string[]>;
  close(): void;
}

let factory: LuaFactory | null = null;

export function tocFiles(): string[] {
  return readFileSync(path.join(ADDON_DIR, "Vigil.toc"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Loads every TOC file in order, then runs the client's startup events (ADDON_LOADED, PLAYER_LOGIN, entering the world). */
export async function loadAddon(opts: HarnessOptions = {}): Promise<Addon> {
  factory ??= new LuaFactory();
  const engine = await factory.createEngine();
  const run = async (code: string) => engine.doString(code);
  const player = opts.player ?? { guid: "Player-6064-0000A001", name: "Paladin", className: "PALADIN" };
  await run(MOCK);
  await run(FLAVORS[opts.flavor ?? "tbc"]);
  if (opts.setup) await run(opts.setup);
  await run(
    `H.units.player = { guid = ${lua(player.guid)}, name = ${lua(player.name)}, player = true, className = "Paladin", classFile = ${lua(player.className ?? "PALADIN")} }`,
  );
  if (opts.savedVariables) await run(`VigilDB = ${opts.savedVariables}`);
  for (const file of tocFiles()) {
    engine.global.set("SRC", readFileSync(path.join(ADDON_DIR, ...file.split("\\")), "utf8"));
    await run(`H.loadFile(${lua(file)}, SRC)`);
  }
  await run(`H.fire("ADDON_LOADED", "Vigil") H.fire("PLAYER_LOGIN") H.fire("PLAYER_ENTERING_WORLD", true, false) H.wait(3)`);

  const addon: Addon = {
    engine,
    run,
    async json<T>(expr: string) {
      const text = (await run(`return H.ns.toJson(${expr})`)) as string;
      return JSON.parse(text) as T;
    },
    async fire(event, ...args) {
      await run(`H.fire(${[lua(event), ...args.map(lua)].join(", ")})`);
    },
    async wait(seconds) {
      await run(`H.wait(${seconds})`);
    },
    async replay(events) {
      const first = events[0];
      if (!first) return;
      await run(`H.epoch = ${first.t / 1000} - H.now - 1`);
      const calls: string[] = [];
      for (const ev of events) {
        if (ev.type === "ENCOUNTER_START" || ev.type === "ENCOUNTER_END") {
          const e = ev.encounter!;
          const extra = ev.type === "ENCOUNTER_END" ? `, ${e.success ? 1 : 0}` : "";
          calls.push(`H.at(${ev.t / 1000}) H.fire(${lua(ev.type)}, ${e.id}, ${lua(e.name)}, ${e.difficulty ?? 0}, 5${extra})`);
          continue;
        }
        const args = cleuArgs(ev);
        if (args) calls.push(`H.cleu(${args.map(lua).join(", ")})`);
      }
      for (let i = 0; i < calls.length; i += 150) await run(calls.slice(i, i + 150).join("\n"));
    },
    async errors() {
      return (await addon.json<string[]>("H.errors")) ?? [];
    },
    async chat() {
      return (await addon.json<string[]>("H.chat")) ?? [];
    },
    close() {
      engine.global.close();
    },
  };
  return addon;
}
