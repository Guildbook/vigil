--[[
  Vigil — Order of Saint Michael personal performance review.

  The addon never reads combat. Fight analysis happens on the guild site from WoWCombatLog.txt,
  which the game writes itself. Vigil only:
  - turns combat logging on (LoggingCombat) when you ask it to, on every login, or in dungeons and raids;
  - snapshots gear, talents and stats out of combat, with a timestamp and your name and realm;
  - keeps those snapshots as a JSON string in SavedVariables (VigilDB.machineExport) and in a copy window;
  - shows a minimap button and a small settings panel (no libraries; the button behaves like LibDBIcon's).

  The Forever client (12.x engine) hands addons "secret values" for many unit queries. Every read goes
  through `clean`, which drops secrets and errors instead of comparing them.
  Not affiliated with or endorsed by Blizzard Entertainment.
]]

local ADDON_NAME = ...
local ADDON_VERSION = "0.2.0"
local DB_VERSION = 1
local EXPORT_VERSION = 1
local MAX_SNAPSHOTS = 50
local PREFIX = "|cffd4af37Vigil|r "

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("ZONE_CHANGED_NEW_AREA")
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
  if db.settings.autoLogInstances == nil then
    db.settings.autoLogInstances = true
  end
  if type(db.minimap) ~= "table" then
    db.minimap = {}
  end
  if type(db.minimap.minimapPos) ~= "number" then
    db.minimap.minimapPos = 220
  end
  db.minimap.hide = db.minimap.hide == true
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
  local settings = ensureDB().settings
  return string.format(
    "combat log: %s, advanced logging: %s, every login: %s, dungeons and raids: %s",
    isLogging() and "ON" or "off",
    advancedLoggingOn() and "on" or "OFF (System > Network > Advanced Combat Logging)",
    settings.autoLog and "on" or "off",
    settings.autoLogInstances and "on" or "off"
  )
end

--- In a dungeon or raid: true plus the instance name and type ("party" or "raid").
local function trackedInstance()
  local inInstance, instanceType = clean(IsInInstance)
  if inInstance and (instanceType == "party" or instanceType == "raid") then
    local name = clean(GetInstanceInfo)
    return true, name or clean(GetRealZoneText) or "", instanceType
  end
  return false, clean(GetRealZoneText) or "", instanceType
end

-- True while logging is on only because the instance option turned it on, so leaving can turn it off.
local loggingForInstance = false

local function applyAutoLogging()
  if not loggingAvailable() then
    return
  end
  local settings = ensureDB().settings
  local tracked = trackedInstance()
  if settings.autoLog then
    loggingForInstance = false
    if not isLogging() then
      setLogging(true)
    end
  elseif settings.autoLogInstances and tracked then
    if not isLogging() and setLogging(true) then
      loggingForInstance = true
      say("combat logging on for this instance.")
    end
  elseif loggingForInstance and not tracked then
    loggingForInstance = false
    if isLogging() and setLogging(false) then
      say("combat logging off: you left the instance.")
    end
  end
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
-- Shared UI actions
-- ---------------------------------------------------------------------------

local ADVANCED_HINT = "turn on Advanced Combat Logging in System > Network for rage, mana and position data."

-- Assigned once the panel exists; the minimap button, slash commands and events call through these.
local refreshPanel = function() end
local togglePanel

local function toggleLogging()
  local on = not isLogging()
  if setLogging(on) then
    loggingForInstance = false
    if on then
      say("combat logging on.")
      if not advancedLoggingOn() then
        say(ADVANCED_HINT)
      end
    elseif ensureDB().settings.autoLog then
      say("combat logging off. It turns back on at your next login while 'every login' is set.")
    else
      say("combat logging off.")
    end
  end
  refreshPanel()
end

--- Where to anchor a tooltip so it opens away from the nearest screen edges (LibDBIcon's rule).
local function tooltipAnchor(owner)
  local x, y = owner:GetCenter()
  if not x or not y then
    return "TOPRIGHT", "BOTTOMLEFT"
  end
  local width, height = UIParent:GetWidth(), UIParent:GetHeight()
  local h = (x > width * 2 / 3) and "RIGHT" or (x < width / 3) and "LEFT" or ""
  local v = (y > height / 2) and "TOP" or "BOTTOM"
  return v .. h, (v == "TOP" and "BOTTOM" or "TOP") .. h
end

local function showTooltip(owner, draggable)
  local tooltip = GameTooltip
  if owner then
    tooltip:SetOwner(owner, "ANCHOR_NONE")
    tooltip:ClearAllPoints()
    local point, relativePoint = tooltipAnchor(owner)
    tooltip:SetPoint(point, owner, relativePoint)
  else
    tooltip:SetOwner(UIParent, "ANCHOR_CURSOR")
  end
  tooltip:AddDoubleLine("Vigil", "v" .. ADDON_VERSION, 1, 0.82, 0, 0.6, 0.6, 0.6)
  if loggingAvailable() then
    local on = isLogging()
    tooltip:AddDoubleLine("Combat logging", on and "On" or "Off", 1, 1, 1, on and 0.3 or 1, on and 1 or 0.3, 0.3)
  else
    tooltip:AddLine("Combat logging: type /combatlog in chat", 1, 1, 1)
  end
  tooltip:AddLine(" ")
  tooltip:AddLine("Left-click: toggle panel", 0.6, 0.6, 0.6)
  tooltip:AddLine("Right-click: toggle combat logging", 0.6, 0.6, 0.6)
  if draggable then
    tooltip:AddLine("Drag: move", 0.6, 0.6, 0.6)
  end
  tooltip:Show()
end

-- ---------------------------------------------------------------------------
-- Minimap button (self-contained; same geometry and behaviour as LibDBIcon)
-- ---------------------------------------------------------------------------

local ICON = "Interface\\AddOns\\Vigil\\Vigil"
local IS_MAINLINE = WOW_PROJECT_ID ~= nil and WOW_PROJECT_ID == WOW_PROJECT_MAINLINE
local MINIMAP_RADIUS = 5
local atan2 = math.atan2 or atan2

-- Per quadrant (right-bottom, left-bottom, right-top, left-top): true where the minimap edge is round.
local MINIMAP_SHAPES = {
  ["ROUND"] = { true, true, true, true },
  ["SQUARE"] = { false, false, false, false },
  ["CORNER-TOPLEFT"] = { false, false, false, true },
  ["CORNER-TOPRIGHT"] = { false, false, true, false },
  ["CORNER-BOTTOMLEFT"] = { false, true, false, false },
  ["CORNER-BOTTOMRIGHT"] = { true, false, false, false },
  ["SIDE-LEFT"] = { false, true, false, true },
  ["SIDE-RIGHT"] = { true, false, true, false },
  ["SIDE-TOP"] = { false, false, true, true },
  ["SIDE-BOTTOM"] = { true, true, false, false },
  ["TRICORNER-TOPLEFT"] = { false, true, true, true },
  ["TRICORNER-TOPRIGHT"] = { true, false, true, true },
  ["TRICORNER-BOTTOMLEFT"] = { true, true, false, true },
  ["TRICORNER-BOTTOMRIGHT"] = { true, true, true, false },
}

local minimapButton

local function updateMinimapPosition()
  if not minimapButton then
    return
  end
  local angle = math.rad(ensureDB().minimap.minimapPos)
  local x, y, q = math.cos(angle), math.sin(angle), 1
  if x < 0 then
    q = q + 1
  end
  if y > 0 then
    q = q + 2
  end
  local shape = clean(GetMinimapShape) or "ROUND"
  local quad = MINIMAP_SHAPES[shape] or MINIMAP_SHAPES.ROUND
  local w = Minimap:GetWidth() / 2 + MINIMAP_RADIUS
  local h = Minimap:GetHeight() / 2 + MINIMAP_RADIUS
  if quad[q] then
    x, y = x * w, y * h
  else
    local diagW = math.sqrt(2 * w * w) - 10
    local diagH = math.sqrt(2 * h * h) - 10
    x = math.max(-w, math.min(x * diagW, w))
    y = math.max(-h, math.min(y * diagH, h))
  end
  minimapButton:ClearAllPoints()
  minimapButton:SetPoint("CENTER", Minimap, "CENTER", x, y)
end

local function onDragUpdate()
  local mx, my = Minimap:GetCenter()
  local px, py = GetCursorPosition()
  local scale = Minimap:GetEffectiveScale()
  if not mx or not px or not scale or scale == 0 then
    return
  end
  px, py = px / scale, py / scale
  ensureDB().minimap.minimapPos = math.deg(atan2(py - my, px - mx)) % 360
  updateMinimapPosition()
end

local function createMinimapButton()
  if minimapButton or not Minimap then
    return minimapButton
  end
  local button = CreateFrame("Button", "VigilMinimapButton", Minimap)
  button:SetFrameStrata("MEDIUM")
  if button.SetFixedFrameStrata then
    button:SetFixedFrameStrata(true)
  end
  button:SetFrameLevel(8)
  if button.SetFixedFrameLevel then
    button:SetFixedFrameLevel(true)
  end
  button:SetSize(31, 31)
  button:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  button:RegisterForDrag("LeftButton")
  button:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")

  local overlay = button:CreateTexture(nil, "OVERLAY")
  overlay:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
  local background = button:CreateTexture(nil, "BACKGROUND")
  background:SetTexture("Interface\\Minimap\\UI-Minimap-Background")
  local icon = button:CreateTexture(nil, "ARTWORK")
  icon:SetTexture(ICON)
  if IS_MAINLINE then
    overlay:SetSize(50, 50)
    overlay:SetPoint("TOPLEFT")
    background:SetSize(24, 24)
    background:SetPoint("CENTER", 0, 1)
    icon:SetSize(18, 18)
    icon:SetPoint("CENTER", 0, 1)
  else
    overlay:SetSize(53, 53)
    overlay:SetPoint("TOPLEFT")
    background:SetSize(20, 20)
    background:SetPoint("TOPLEFT", 7, -5)
    icon:SetSize(17, 17)
    icon:SetPoint("TOPLEFT", 7, -6)
  end
  if icon.SetMask then
    pcall(icon.SetMask, icon, "Interface\\CharacterFrame\\TempPortraitAlphaMask")
  end
  button.icon = icon

  button:SetScript("OnEnter", function(self)
    if not self.isMoving then
      showTooltip(self, true)
    end
  end)
  button:SetScript("OnLeave", function()
    GameTooltip:Hide()
  end)
  button:SetScript("OnMouseDown", function(self)
    self.icon:SetTexCoord(0.08, 0.92, 0.08, 0.92)
  end)
  button:SetScript("OnMouseUp", function(self)
    self.icon:SetTexCoord(0, 1, 0, 1)
  end)
  button:SetScript("OnDragStart", function(self)
    self.isMoving = true
    self:LockHighlight()
    GameTooltip:Hide()
    self:SetScript("OnUpdate", onDragUpdate)
  end)
  button:SetScript("OnDragStop", function(self)
    self:SetScript("OnUpdate", nil)
    self.isMoving = false
    self:UnlockHighlight()
    self.icon:SetTexCoord(0, 1, 0, 1)
  end)
  button:SetScript("OnClick", function(self, mouseButton)
    if mouseButton == "RightButton" then
      toggleLogging()
    else
      togglePanel()
    end
    if GameTooltip:IsOwned(self) then
      showTooltip(self, true)
    end
  end)

  minimapButton = button
  return button
end

local function applyMinimapVisibility()
  if ensureDB().minimap.hide then
    if minimapButton then
      minimapButton:Hide()
    end
    return
  end
  if createMinimapButton() then
    updateMinimapPosition()
    minimapButton:Show()
  end
end

local function setMinimapHidden(hide)
  ensureDB().minimap.hide = hide and true or false
  applyMinimapVisibility()
  refreshPanel()
end

-- ---------------------------------------------------------------------------
-- Panel
-- ---------------------------------------------------------------------------

local PANEL_WIDTH = 340
local panel

local function addCheckbox(parent, label, anchor, onToggle)
  local check = CreateFrame("CheckButton", nil, parent, "UICheckButtonTemplate")
  check:SetSize(24, 24)
  check:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, -6)
  local text = check:CreateFontString(nil, "ARTWORK", "GameFontHighlight")
  text:SetPoint("LEFT", check, "RIGHT", 2, 1)
  text:SetText(label)
  check:SetScript("OnClick", function(self)
    onToggle(self:GetChecked() and true or false)
    refreshPanel()
  end)
  return check
end

local function createPanel()
  local f = CreateFrame("Frame", "VigilPanel", UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
  f:SetSize(PANEL_WIDTH, 250)
  f:SetPoint("CENTER", 0, 80)
  f:SetFrameStrata("DIALOG")
  f:SetToplevel(true)
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", f.StopMovingOrSizing)
  f:Hide()
  if f.SetBackdrop then
    f:SetBackdrop({
      bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
      edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
      tile = true,
      tileSize = 32,
      edgeSize = 32,
      insets = { left = 8, right = 8, top = 8, bottom = 8 },
    })
  end
  if type(UISpecialFrames) == "table" then
    table.insert(UISpecialFrames, "VigilPanel")
  end

  local icon = f:CreateTexture(nil, "ARTWORK")
  icon:SetTexture(ICON)
  icon:SetSize(20, 20)
  icon:SetPoint("TOPLEFT", 18, -16)

  local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  title:SetPoint("LEFT", icon, "RIGHT", 6, 0)
  title:SetText("Vigil")

  local version = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  version:SetPoint("BOTTOMLEFT", title, "BOTTOMRIGHT", 6, 1)
  version:SetText("v" .. ADDON_VERSION)

  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -4, -4)

  local status = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  status:SetPoint("TOPLEFT", icon, "BOTTOMLEFT", 2, -16)
  f.status = status

  local toggle = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
  toggle:SetSize(96, 22)
  toggle:SetPoint("RIGHT", f, "RIGHT", -20, 0)
  toggle:SetPoint("TOP", status, "TOP", 0, 5)
  toggle:SetScript("OnClick", toggleLogging)
  f.toggle = toggle

  local advanced = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  advanced:SetPoint("TOPLEFT", status, "BOTTOMLEFT", 0, -8)
  advanced:SetWidth(PANEL_WIDTH - 40)
  advanced:SetJustifyH("LEFT")
  f.advanced = advanced

  local zone = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  zone:SetPoint("TOPLEFT", advanced, "BOTTOMLEFT", 0, -6)
  zone:SetWidth(PANEL_WIDTH - 40)
  zone:SetJustifyH("LEFT")
  f.zone = zone

  local anchor = CreateFrame("Frame", nil, f)
  anchor:SetSize(1, 1)
  anchor:SetPoint("TOPLEFT", zone, "BOTTOMLEFT", -4, -4)

  f.autoLog = addCheckbox(f, "Keep combat logging on at every login", anchor, function(on)
    ensureDB().settings.autoLog = on
    if on then
      applyAutoLogging()
    end
  end)
  f.autoLogInstances = addCheckbox(f, "Turn combat logging on in dungeons and raids", f.autoLog, function(on)
    ensureDB().settings.autoLogInstances = on
    if on then
      applyAutoLogging()
    end
  end)
  f.minimap = addCheckbox(f, "Show minimap button", f.autoLogInstances, function(on)
    setMinimapHidden(not on)
  end)

  local footer = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  footer:SetPoint("BOTTOMLEFT", 20, 18)
  footer:SetWidth(PANEL_WIDTH - 40)
  footer:SetJustifyH("LEFT")
  footer:SetText("Uploads happen from the Vigil desktop app. This addon never reads combat.")

  local elapsed = 0
  f:SetScript("OnUpdate", function(_, dt)
    elapsed = elapsed + (dt or 0)
    if elapsed >= 1 then
      elapsed = 0
      refreshPanel()
    end
  end)
  f:SetScript("OnShow", function()
    refreshPanel()
  end)
  return f
end

refreshPanel = function()
  if not panel or not panel:IsShown() then
    return
  end
  local db = ensureDB()
  if loggingAvailable() then
    local on = isLogging()
    panel.status:SetText("Combat logging: " .. (on and "|cff4cff4cOn|r" or "|cffff4c4cOff|r"))
    panel.toggle:SetText(on and "Turn off" or "Turn on")
    panel.toggle:Enable()
  else
    panel.status:SetText("Combat logging: type /combatlog in chat")
    panel.toggle:SetText("Unavailable")
    panel.toggle:Disable()
  end
  if advancedLoggingOn() then
    panel.advanced:SetText("Advanced Combat Logging is on.")
  else
    panel.advanced:SetText("|cffffb24cAdvanced Combat Logging is off. Turn it on in System > Network.|r")
  end
  local tracked, name, instanceType = trackedInstance()
  if tracked then
    panel.zone:SetText(string.format(
      "In %s: %s (%s)",
      instanceType == "raid" and "a raid" or "a dungeon",
      name ~= "" and name or "unknown",
      isLogging() and "logging" or "not logging"
    ))
  else
    panel.zone:SetText(string.format("%s: not a dungeon or raid", name ~= "" and name or "This zone"))
  end
  panel.autoLog:SetChecked(db.settings.autoLog)
  panel.autoLogInstances:SetChecked(db.settings.autoLogInstances)
  panel.minimap:SetChecked(not db.minimap.hide)
end

togglePanel = function()
  panel = panel or createPanel()
  if panel:IsShown() then
    panel:Hide()
  else
    panel:Show()
  end
end

-- Addon compartment (retail-style clients read these names from the TOC; other clients ignore them).
function Vigil_OnAddonCompartmentClick(_, mouseButton)
  if mouseButton == "RightButton" then
    toggleLogging()
  else
    togglePanel()
  end
end

function Vigil_OnAddonCompartmentEnter(_, menuButtonFrame)
  showTooltip(type(menuButtonFrame) == "table" and menuButtonFrame.GetCenter and menuButtonFrame or nil, false)
end

function Vigil_OnAddonCompartmentLeave()
  GameTooltip:Hide()
end

-- ---------------------------------------------------------------------------
-- Slash commands
-- ---------------------------------------------------------------------------

local function printHelp()
  say("commands:")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil — open or close the Vigil panel")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil log — turn combat logging on or off now")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil log on | off — combat logging now, and on every login")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil minimap — show or hide the minimap button")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil status — logging state and snapshot count")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil snapshot — save gear, talents and stats now (out of combat)")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil export — copy window with your snapshots")
  DEFAULT_CHAT_FRAME:AddMessage("  /vigil clear — delete saved snapshots")
  DEFAULT_CHAT_FRAME:AddMessage("Uploads happen from the Vigil desktop app.")
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
  if msg == "" then
    togglePanel()
  elseif msg == "help" then
    printHelp()
  elseif msg == "log" then
    toggleLogging()
  elseif msg == "log on" then
    db.settings.autoLog = true
    if setLogging(true) then
      loggingForInstance = false
      say("combat logging on. It turns back on at every login until /vigil log off.")
    end
    if not advancedLoggingOn() then
      say(ADVANCED_HINT)
    end
    refreshPanel()
  elseif msg == "log off" then
    db.settings.autoLog = false
    if setLogging(false) then
      loggingForInstance = false
      say("combat logging off.")
    end
    refreshPanel()
  elseif msg == "minimap" then
    setMinimapHidden(not db.minimap.hide)
    if db.minimap.hide then
      say("minimap button hidden. Type /vigil minimap to show it again.")
    else
      say("minimap button shown.")
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
      applyMinimapVisibility()
    end
  elseif event == "PLAYER_LOGIN" then
    applyMinimapVisibility()
    scheduleSnapshot("login")
  elseif event == "PLAYER_ENTERING_WORLD" or event == "ZONE_CHANGED_NEW_AREA" then
    applyAutoLogging()
    refreshPanel()
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
