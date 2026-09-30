--[[
  Vigil: Order of Saint Michael personal performance review.

  In game, Vigil shows the fight in progress (damage, DPS, idle time) from the client's combat events, boss intel
  for known bosses, and a few quiet callouts. The full analysis and uploads happen in the Vigil desktop app from
  WoWCombatLog.txt, which the client writes to disk in 48 KB batches, so the desktop view of a solo fight can lag
  by minutes. The addon also:
  - turns combat logging on (LoggingCombat) when you ask it to, on every login, or in dungeons and raids;
  - snapshots gear, talents and stats out of combat into SavedVariables (VigilDB.machineExport);
  - shows a minimap button and a settings panel (no libraries).

  Files share one private table (the addon's `...`); the only globals are VigilDB, the slash command and the
  addon compartment callbacks. The 12.x engine (retail, the Forever client) hands addons "secret values" for many
  unit queries (enemy GUIDs and names, in-combat auras and damage meter amounts). Secrets allow no comparison,
  arithmetic, indexing or string methods, only storing and display. Unit reads go through `clean`, which drops
  secrets and errors; the few places that display secrets (Meter.lua, the live panel) check `isSecret` first.

  Not affiliated with or endorsed by Blizzard Entertainment.
]]

local ADDON_NAME, ns = ...

ns.name = ADDON_NAME
-- ns.version is set by Vigil.lua (ADDON_VERSION, kept in step with the TOC); read it at run time, not load time.
ns.DB_VERSION = 2
ns.EXPORT_VERSION = 1
ns.MAX_SNAPSHOTS = 50
ns.MAX_SAVED_FIGHTS = 5
ns.ICON = "Interface\\AddOns\\Vigil\\Vigil"
ns.PREFIX = "|cffd4af37Vigil|r "

function ns.say(msg)
  DEFAULT_CHAT_FRAME:AddMessage(ns.PREFIX .. msg)
end

local function isSecret(v)
  return type(issecretvalue) == "function" and issecretvalue(v)
end
ns.isSecret = isSecret

--- Call an API defensively: nil when the function is missing, errors, or returns a secret.
function ns.clean(fn, ...)
  if type(fn) ~= "function" then
    return nil
  end
  local ok, a, b, c, d, e = pcall(fn, ...)
  if not ok then
    return nil
  end
  if isSecret(a) then
    a = nil
  end
  if isSecret(b) then
    b = nil
  end
  if isSecret(c) then
    c = nil
  end
  if isSecret(d) then
    d = nil
  end
  if isSecret(e) then
    e = nil
  end
  return a, b, c, d, e
end
local clean = ns.clean

function ns.inCombat()
  if clean(InCombatLockdown) then
    return true
  end
  return clean(UnitAffectingCombat, "player") == true
end

function ns.now()
  return clean(GetTime) or 0
end

function ns.after(delay, fn)
  if type(C_Timer) == "table" and type(C_Timer.After) == "function" then
    C_Timer.After(delay, fn)
    return true
  end
  return false
end

--- A repeating timer; false when the client has no C_Timer (callers then refresh on events only).
function ns.every(interval, fn)
  if type(C_Timer) == "table" and type(C_Timer.NewTicker) == "function" then
    return C_Timer.NewTicker(interval, fn)
  end
  if type(C_Timer) == "table" and type(C_Timer.After) == "function" then
    local handle = { cancelled = false }
    function handle:Cancel()
      self.cancelled = true
    end
    local function step()
      if handle.cancelled then
        return
      end
      fn()
      C_Timer.After(interval, step)
    end
    C_Timer.After(interval, step)
    return handle
  end
  return false
end

-- ---------------------------------------------------------------------------
-- Client API differences
-- ---------------------------------------------------------------------------

local buildNumber = select(4, clean(GetBuildInfo))
ns.interface = type(buildNumber) == "number" and buildNumber or 0
-- Retail-style minimap art. The Forever beta also reports WOW_PROJECT_MAINLINE, as LibDBIcon sees it too.
-- Whether combat events reach addons is a separate question, answered at run time by Fight.lua (F.available).
ns.IS_MAINLINE = WOW_PROJECT_ID ~= nil and WOW_PROJECT_ID == WOW_PROJECT_MAINLINE

ns.BACKDROP_TEMPLATE = BackdropTemplateMixin and "BackdropTemplate" or nil
ns.QUESTION_ICON = "Interface\\Icons\\INV_Misc_QuestionMark"

--- A spell's icon: C_Spell on modern clients, GetSpellTexture on Classic, then the generated icon name.
function ns.spellTexture(spellId, fallbackIcon)
  local tex
  if spellId then
    if type(C_Spell) == "table" and type(C_Spell.GetSpellTexture) == "function" then
      tex = clean(C_Spell.GetSpellTexture, spellId)
    end
    if not tex and type(GetSpellTexture) == "function" then
      tex = clean(GetSpellTexture, spellId)
    end
  end
  if not tex and fallbackIcon then
    tex = "Interface\\Icons\\" .. fallbackIcon
  end
  return tex or ns.QUESTION_ICON
end

--- A spell's name in the client's language, or nil.
function ns.spellName(spellId)
  if not spellId then
    return nil
  end
  if type(C_Spell) == "table" and type(C_Spell.GetSpellInfo) == "function" then
    local info = clean(C_Spell.GetSpellInfo, spellId)
    if type(info) == "table" and type(info.name) == "string" then
      return info.name
    end
  end
  if type(GetSpellInfo) == "function" then
    local name = clean(GetSpellInfo, spellId)
    if type(name) == "string" then
      return name
    end
  end
  return nil
end

--- `Creature-0-[server]-[instance]-[zone]-[npcId]-[spawn]` (also Vehicle-): the NPC ID, or nil.
function ns.npcIdFromGuid(guid)
  if type(guid) ~= "string" or isSecret(guid) then
    return nil
  end
  local kind, id = guid:match("^(%a+)%-%d+%-%d+%-%d+%-%d+%-(%d+)")
  if kind ~= "Creature" and kind ~= "Vehicle" then
    return nil
  end
  id = tonumber(id)
  if id and id > 0 then
    return id
  end
  return nil
end

local function auraFields(aura)
  return aura.name, aura.spellId
end

--- Every helpful aura name on a unit, passed to `visit(name, spellId)`. True when the list was read; false when
--- the client keeps the unit's auras from addons (an error, a forbidden table or secret values, as the 12.x
--- engine does in combat), so callers can tell hidden buffs from no buffs.
function ns.eachBuff(unit, visit)
  if type(C_UnitAuras) == "table" and type(C_UnitAuras.GetAuraDataByIndex) == "function" then
    for i = 1, 40 do
      local ok, aura = pcall(C_UnitAuras.GetAuraDataByIndex, unit, i, "HELPFUL")
      if not ok or isSecret(aura) then
        return false
      end
      if type(aura) ~= "table" then
        return true
      end
      local readable, name, spellId = pcall(auraFields, aura)
      if not readable or isSecret(name) then
        return false
      end
      if type(name) == "string" then
        visit(name, not isSecret(spellId) and spellId or nil)
      end
    end
    return true
  end
  if type(UnitBuff) == "function" then
    for i = 1, 40 do
      local ok, name, _, _, _, _, _, _, _, _, spellId = pcall(UnitBuff, unit, i)
      if not ok or isSecret(name) then
        return false
      end
      if not name then
        return true
      end
      visit(name, not isSecret(spellId) and spellId or nil)
    end
    return true
  end
  return false
end

-- ---------------------------------------------------------------------------
-- Formatting
-- ---------------------------------------------------------------------------

--- Amounts (damage, healing): whole numbers below 10,000, then "12.3K" and "1.23M".
function ns.formatNumber(n)
  n = n or 0
  if n >= 1000000 then
    return string.format("%.2fM", n / 1000000)
  elseif n >= 10000 then
    return string.format("%.1fK", n / 1000)
  end
  return tostring(math.floor(n + 0.5))
end

--- Rates (DPS, HPS): one decimal below 1,000, then "1.2K" and "1.23M".
function ns.formatRate(n)
  n = n or 0
  if n >= 1000000 then
    return string.format("%.2fM", n / 1000000)
  elseif n >= 1000 then
    return string.format("%.1fK", n / 1000)
  end
  return string.format("%.1f", n)
end

function ns.formatTime(seconds)
  seconds = math.max(0, math.floor((seconds or 0) + 0.5))
  return string.format("%d:%02d", math.floor(seconds / 60), seconds % 60)
end

function ns.formatSeconds(seconds)
  return string.format("%.1f s", seconds or 0)
end

-- ---------------------------------------------------------------------------
-- SavedVariables
-- ---------------------------------------------------------------------------

local function defaults(target, values)
  for key, value in pairs(values) do
    if type(value) == "table" then
      if type(target[key]) ~= "table" then
        target[key] = {}
      end
      defaults(target[key], value)
    elseif target[key] == nil or type(target[key]) ~= type(value) then
      target[key] = value
    end
  end
end

local DEFAULTS = {
  settings = { autoLog = false, autoLogInstances = true },
  minimap = { minimapPos = 220, hide = false },
  live = { shown = true, locked = false, scale = 1, hideOutOfCombat = false },
  intel = { enabled = true, locked = false, scale = 1, collapsed = false },
  callouts = { enabled = true, idle = true, idleSeconds = 2.5, buffs = true },
}

--[[
  VigilDB v1 (0.2.x): version, snapshots, settings { autoLog, autoLogInstances }, minimap, machineExport.
  v2 (0.3.0) keeps all of that and adds live, intel and callouts settings and `fights`, the last few fight
  summaries. Panel positions live in live.point and intel.point once moved.
]]
function ns.ensureDB()
  if type(VigilDB) ~= "table" then
    VigilDB = {}
  end
  local db = VigilDB
  if type(db.snapshots) ~= "table" then
    db.snapshots = {}
  end
  if type(db.fights) ~= "table" then
    db.fights = {}
  end
  defaults(db, DEFAULTS)
  db.minimap.hide = db.minimap.hide == true
  if db.live.scale < 0.5 or db.live.scale > 2 then
    db.live.scale = 1
  end
  if db.intel.scale < 0.5 or db.intel.scale > 2 then
    db.intel.scale = 1
  end
  if db.callouts.idleSeconds < 1 or db.callouts.idleSeconds > 10 then
    db.callouts.idleSeconds = 2.5
  end
  while #db.fights > ns.MAX_SAVED_FIGHTS do
    table.remove(db.fights, 1)
  end
  db.machineExport = db.machineExport or '{"version":1,"addon":"Vigil","snapshots":[]}'
  db.version = ns.DB_VERSION
  return db
end

-- ---------------------------------------------------------------------------
-- JSON (write-only, enough for flat snapshot tables)
-- ---------------------------------------------------------------------------

local function jsonEscape(s)
  s = tostring(s or "")
  s = s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"):gsub("\r", "\\r"):gsub("\t", "\\t")
  return s
end

local function toJson(v)
  local t = type(v)
  if v == nil then
    return "null"
  elseif t == "boolean" then
    return v and "true" or "false"
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then
      return "null"
    end
    if v == math.floor(v) then
      return string.format("%d", v)
    end
    return string.format("%.4f", v)
  elseif t == "string" then
    return '"' .. jsonEscape(v) .. '"'
  elseif t == "table" then
    if #v > 0 or next(v) == nil then
      local parts = {}
      for i, item in ipairs(v) do
        parts[i] = toJson(item)
      end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do
      table.insert(keys, tostring(k))
    end
    table.sort(keys)
    local parts = {}
    for _, k in ipairs(keys) do
      table.insert(parts, '"' .. jsonEscape(k) .. '":' .. toJson(v[k]))
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end
ns.toJson = toJson

function ns.refreshMachineExport(db)
  db = db or ns.ensureDB()
  db.machineExport = toJson({
    version = ns.EXPORT_VERSION,
    addon = "Vigil",
    addonVersion = ns.version,
    snapshots = db.snapshots,
  })
  return db.machineExport
end

-- ---------------------------------------------------------------------------
-- Events and messages
-- ---------------------------------------------------------------------------

local eventFrame = CreateFrame("Frame")
local eventHandlers = {}

--- Registers `fn(event, ...)` for a client event. False when the client refuses the event.
function ns.on(event, fn)
  local list = eventHandlers[event]
  if not list then
    local ok = pcall(eventFrame.RegisterEvent, eventFrame, event)
    if not ok then
      return false
    end
    list = {}
    eventHandlers[event] = list
  end
  table.insert(list, fn)
  return true
end

function ns.off(event, fn)
  local list = eventHandlers[event]
  if not list then
    return
  end
  for i = #list, 1, -1 do
    if list[i] == fn then
      table.remove(list, i)
    end
  end
  if #list == 0 then
    eventHandlers[event] = nil
    pcall(eventFrame.UnregisterEvent, eventFrame, event)
  end
end

eventFrame:SetScript("OnEvent", function(_, event, ...)
  local list = eventHandlers[event]
  if not list then
    return
  end
  for i = 1, #list do
    list[i](event, ...)
  end
end)

local listeners = {}

--- Internal messages between the files ("FIGHT_START", "FIGHT_END", "BOSS", "SETTINGS").
function ns.listen(message, fn)
  listeners[message] = listeners[message] or {}
  table.insert(listeners[message], fn)
end

function ns.emit(message, ...)
  local list = listeners[message]
  if not list then
    return
  end
  for i = 1, #list do
    list[i](...)
  end
end

-- Replaced by Settings.lua; logging and events call it whenever cached state changes.
function ns.refreshPanel() end
