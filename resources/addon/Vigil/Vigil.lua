--[[
  Vigil — Order of Saint Michael personal performance review.

  The addon never reads combat. Fight analysis happens on the guild site from WoWCombatLog.txt,
  which the game writes itself. Vigil only:
  - turns combat logging on (LoggingCombat) when you ask it to, and again on every login;
  - snapshots gear, talents and stats out of combat, with a timestamp and your name and realm;
  - keeps those snapshots as a JSON string in SavedVariables (VigilDB.machineExport) and in a copy window.

  The Forever client (12.x engine) hands addons "secret values" for many unit queries. Every read goes
  through `clean`, which drops secrets and errors instead of comparing them.
  Not affiliated with or endorsed by Blizzard Entertainment.
]]

local ADDON_NAME = ...
local ADDON_VERSION = "0.1.0"
local DB_VERSION = 1
local EXPORT_VERSION = 1
local MAX_SNAPSHOTS = 50
local PREFIX = "|cffd4af37Vigil|r "

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("PLAYER_REGEN_ENABLED")
frame:RegisterEvent("PLAYER_EQUIPMENT_CHANGED")
frame:RegisterEvent("PLAYER_LEVEL_UP")
frame:RegisterEvent("PLAYER_TALENT_UPDATE")
pcall(frame.RegisterEvent, frame, "TRAIT_CONFIG_UPDATED")

local function say(msg)
  DEFAULT_CHAT_FRAME:AddMessage(PREFIX .. msg)
end

local function isSecret(v)
  return type(issecretvalue) == "function" and issecretvalue(v)
end

--- Call an API defensively: nil when the function is missing, errors, or returns a secret.
local function clean(fn, ...)
  if type(fn) ~= "function" then
    return nil
  end
  local ok, a, b, c, d = pcall(fn, ...)
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
  return a, b, c, d
end

local function inCombat()
  local locked = clean(InCombatLockdown)
  if locked then
    return true
  end
  return clean(UnitAffectingCombat, "player") == true
end

local function ensureDB()
  if type(VigilDB) ~= "table" then
    VigilDB = {}
  end
  local db = VigilDB
  db.version = DB_VERSION
  db.snapshots = db.snapshots or {}
  db.settings = db.settings or {}
  if db.settings.autoLog == nil then
    db.settings.autoLog = false
  end
  db.machineExport = db.machineExport or '{"version":1,"addon":"Vigil","snapshots":[]}'
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

local function refreshMachineExport(db)
  db = db or ensureDB()
  db.machineExport = toJson({
    version = EXPORT_VERSION,
    addon = "Vigil",
    addonVersion = ADDON_VERSION,
    snapshots = db.snapshots,
  })
  return db.machineExport
end

-- ---------------------------------------------------------------------------
-- Combat logging
-- ---------------------------------------------------------------------------

local function loggingAvailable()
  return type(LoggingCombat) == "function"
end

local function isLogging()
  return clean(LoggingCombat) == true
end

local function advancedLoggingOn()
  if type(C_CVar) == "table" then
    return clean(C_CVar.GetCVar, "advancedCombatLogging") == "1"
  end
  return clean(GetCVar, "advancedCombatLogging") == "1"
end

local function setLogging(on)
  if not loggingAvailable() then
    say("LoggingCombat is not available on this client. Type /combatlog in chat instead.")
    return false
  end
  local ok = pcall(LoggingCombat, on and true or false)
  if not ok then
    say("The client refused to toggle combat logging. Type /combatlog in chat instead.")
    return false
  end
  return true
end

local function logStatusLine()
  if not loggingAvailable() then
    return "combat log: LoggingCombat unavailable; use /combatlog"
  end
  return string.format(
    "combat log: %s, advanced logging: %s, auto: %s",
    isLogging() and "ON" or "off",
    advancedLoggingOn() and "on" or "OFF (System > Network > Advanced Combat Logging)",
    ensureDB().settings.autoLog and "on" or "off"
  )
end

-- ---------------------------------------------------------------------------
-- Snapshots
-- ---------------------------------------------------------------------------

local GEAR_SLOTS = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 }

local function itemFromLink(link)
  if type(link) ~= "string" then
    return nil
  end
  local itemId, enchantId = link:match("item:(%d+):(%d*)")
  if not itemId then
    return nil
  end
  return tonumber(itemId), tonumber(enchantId)
end

local function readGear()
  local gear = {}
  for _, slot in ipairs(GEAR_SLOTS) do
    local itemId, enchantId = itemFromLink(clean(GetInventoryItemLink, "player", slot))
    if itemId then
      local entry = { slot = slot, itemId = itemId }
      if enchantId and enchantId > 0 then
        entry.enchantId = enchantId
      end
      table.insert(gear, entry)
    end
  end
  return gear
end

--- Modern trait trees (C_Traits) first, then the Classic talent API.
local function readTalents()
  local talents = {}
  if type(C_ClassTalents) == "table" and type(C_Traits) == "table" then
    local configId = clean(C_ClassTalents.GetActiveConfigID)
    local config = configId and clean(C_Traits.GetConfigInfo, configId)
    if type(config) == "table" and type(config.treeIDs) == "table" then
      for _, treeId in ipairs(config.treeIDs) do
        local nodes = clean(C_Traits.GetTreeNodes, treeId)
        if type(nodes) == "table" then
          for _, nodeId in ipairs(nodes) do
            local node = clean(C_Traits.GetNodeInfo, configId, nodeId)
            local rank = type(node) == "table" and node.activeRank or nil
            if type(rank) == "number" and rank > 0 then
              table.insert(talents, { node = nodeId, rank = rank })
            end
          end
        end
      end
      return talents, "traits"
    end
  end
  local tabs = clean(GetNumTalentTabs)
  if type(tabs) == "number" then
    for tab = 1, tabs do
      local count = clean(GetNumTalents, tab) or 0
      for index = 1, count do
        local name, _, _, _, rank = clean(GetTalentInfo, tab, index)
        if name and type(rank) == "number" and rank > 0 then
          table.insert(talents, { tab = tab, index = index, name = name, rank = rank })
        end
      end
    end
    return talents, "classic"
  end
  return talents, "none"
end

local function readStats()
  local stats = {}
  local names = { "str", "agi", "sta", "int", "spi" }
  for i, key in ipairs(names) do
    local _, effective = clean(UnitStat, "player", i)
    stats[key] = effective
  end
  local base, pos, neg = clean(UnitAttackPower, "player")
  if base then
    stats.attackPower = base + (pos or 0) + (neg or 0)
  end
  local _, armor = clean(UnitArmor, "player")
  stats.armor = armor
  stats.critMelee = clean(GetCritChance)
  stats.critSpell = clean(GetSpellCritChance, 2)
  stats.hit = clean(GetHitModifier)
  stats.spellPower = clean(GetSpellBonusDamage, 2)
  stats.healing = clean(GetSpellBonusHealing)
  stats.dodge = clean(GetDodgeChance)
  stats.parry = clean(GetParryChance)
  stats.block = clean(GetBlockChance)
  stats.defense = clean(UnitDefense, "player")
  local mainSpeed, offSpeed = clean(UnitAttackSpeed, "player")
  stats.mainHandSpeed = mainSpeed
  stats.offHandSpeed = offSpeed
  stats.maxHealth = clean(UnitHealthMax, "player")
  stats.maxPower = clean(UnitPowerMax, "player")
  return stats
end

local function buildSnapshot()
  local name, realm = clean(UnitFullName, "player")
  if not realm or realm == "" then
    realm = clean(GetNormalizedRealmName) or clean(GetRealmName)
  end
  local _, classFile = clean(UnitClass, "player")
  local _, raceFile = clean(UnitRace, "player")
  local talents, talentSource = readTalents()
  return {
    at = clean(time) or 0,
    name = name,
    realm = realm,
    guid = clean(UnitGUID, "player"),
    class = classFile,
    race = raceFile,
    level = clean(UnitLevel, "player"),
    stats = readStats(),
    gear = readGear(),
    talents = talents,
    talentSource = talentSource,
  }
end

--- Same character, gear, talents and stats as the last snapshot: nothing new to keep.
local function sameAsLast(db, snap)
  local last = db.snapshots[#db.snapshots]
  if not last then
    return false
  end
  local a, b = last.at, snap.at
  last.at, snap.at = 0, 0
  local same = toJson(last) == toJson(snap)
  last.at, snap.at = a, b
  return same
end

local function takeSnapshot(reason, verbose)
  if inCombat() then
    if verbose then
      say("snapshots wait until you leave combat.")
    end
    return false
  end
  local db = ensureDB()
  local snap = buildSnapshot()
  if not snap.name then
    return false
  end
  if sameAsLast(db, snap) then
    if verbose then
      say("nothing changed since the last snapshot.")
    end
    return false
  end
  snap.reason = reason
  table.insert(db.snapshots, snap)
  while #db.snapshots > MAX_SNAPSHOTS do
    table.remove(db.snapshots, 1)
  end
  refreshMachineExport(db)
  if verbose then
    say(string.format("snapshot saved: level %s, %d gear slots.", tostring(snap.level or "?"), #snap.gear))
  end
  return true
end

local pendingSnapshot = false
local function scheduleSnapshot(reason)
  if pendingSnapshot then
    return
  end
  pendingSnapshot = true
  local run = function()
    pendingSnapshot = false
    takeSnapshot(reason, false)
  end
  if type(C_Timer) == "table" and type(C_Timer.After) == "function" then
    C_Timer.After(2, run)
  else
    run()
  end
end

-- ---------------------------------------------------------------------------
-- Copy window
-- ---------------------------------------------------------------------------

local exportFrame

local function showExportFrame()
  if not exportFrame then
    exportFrame = CreateFrame("Frame", "VigilExportFrame", UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
    exportFrame:SetSize(480, 320)
    exportFrame:SetPoint("CENTER")
    exportFrame:SetFrameStrata("DIALOG")
    exportFrame:SetMovable(true)
    exportFrame:EnableMouse(true)
    exportFrame:RegisterForDrag("LeftButton")
    exportFrame:SetScript("OnDragStart", exportFrame.StartMoving)
    exportFrame:SetScript("OnDragStop", exportFrame.StopMovingOrSizing)
    exportFrame:Hide()
    if exportFrame.SetBackdrop then
      exportFrame:SetBackdrop({
        bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
        edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
        tile = true,
        tileSize = 32,
        edgeSize = 32,
        insets = { left = 8, right = 8, top = 8, bottom = 8 },
      })
    end

    local title = exportFrame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
    title:SetPoint("TOP", 0, -14)
    title:SetText("Vigil export")

    local close = CreateFrame("Button", nil, exportFrame, "UIPanelCloseButton")
    close:SetPoint("TOPRIGHT", -4, -4)

    local scroll = CreateFrame("ScrollFrame", nil, exportFrame, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", 16, -40)
    scroll:SetPoint("BOTTOMRIGHT", -36, 44)

    local edit = CreateFrame("EditBox", nil, scroll)
    edit:SetMultiLine(true)
    edit:SetFontObject(ChatFontNormal)
    edit:SetWidth(410)
    edit:SetAutoFocus(false)
    edit:SetScript("OnEscapePressed", function(self)
      self:ClearFocus()
      exportFrame:Hide()
    end)
    scroll:SetScrollChild(edit)
    exportFrame.edit = edit

    local hint = exportFrame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    hint:SetPoint("BOTTOMLEFT", 16, 16)
    hint:SetPoint("BOTTOMRIGHT", -16, 16)
    hint:SetJustifyH("LEFT")
    hint:SetText("Select all and copy, or /reload and attach SavedVariables/Vigil.lua on the guild site.")
  end

  exportFrame.edit:SetText(refreshMachineExport())
  exportFrame.edit:HighlightText()
  exportFrame:Show()
  exportFrame.edit:SetFocus()
end

-- ---------------------------------------------------------------------------
-- Slash commands
-- ---------------------------------------------------------------------------

local function printHelp()
  say("commands:")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil log on | off — combat logging now, and on every login")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil status — logging state and snapshot count")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil snapshot — save gear, talents and stats now (out of combat)")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil export — copy window with your snapshots")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil clear — delete saved snapshots")
  DEFAULT_CHAT_FRAME:AddMessage("Upload Logs/WoWCombatLog.txt on the guild site under Vigil.")
end

local function printStatus()
  local db = ensureDB()
  say(string.format("v%s, %d snapshot(s).", ADDON_VERSION, #db.snapshots))
  say(logStatusLine())
end

SLASH_VIGIL1 = "/vigil"
SlashCmdList.VIGIL = function(msg)
  msg = string.lower(strtrim(msg or ""))
  local db = ensureDB()
  if msg == "" or msg == "help" then
    printHelp()
  elseif msg == "log on" then
    db.settings.autoLog = true
    if setLogging(true) then
      say("combat logging on. It turns back on at every login until /vigil log off.")
    end
    if not advancedLoggingOn() then
      say("turn on Advanced Combat Logging in System > Network for rage, mana and position data.")
    end
  elseif msg == "log off" then
    db.settings.autoLog = false
    if setLogging(false) then
      say("combat logging off.")
    end
  elseif msg == "status" then
    printStatus()
  elseif msg == "snapshot" then
    takeSnapshot("manual", true)
  elseif msg == "export" then
    showExportFrame()
  elseif msg == "clear" then
    db.snapshots = {}
    refreshMachineExport(db)
    say("snapshots cleared.")
  else
    printHelp()
  end
end

frame:SetScript("OnEvent", function(_, event, ...)
  if event == "ADDON_LOADED" then
    if ... == ADDON_NAME then
      refreshMachineExport(ensureDB())
    end
  elseif event == "PLAYER_LOGIN" then
    scheduleSnapshot("login")
  elseif event == "PLAYER_ENTERING_WORLD" then
    if ensureDB().settings.autoLog and loggingAvailable() and not isLogging() then
      setLogging(true)
    end
  elseif event == "PLAYER_REGEN_ENABLED" then
    scheduleSnapshot("combat_end")
  elseif event == "PLAYER_EQUIPMENT_CHANGED" then
    scheduleSnapshot("gear")
  elseif event == "PLAYER_LEVEL_UP" then
    scheduleSnapshot("level")
  elseif event == "PLAYER_TALENT_UPDATE" or event == "TRAIT_CONFIG_UPDATED" then
    scheduleSnapshot("talents")
  end
end)
