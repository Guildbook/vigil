local _, ns = ...

local clean, say, isSecret = ns.clean, ns.say, ns.isSecret

local S = {}
ns.snapshots = S

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
            local rank = type(node) == "table" and not isSecret(node) and node.activeRank or nil
            if type(rank) == "number" and not isSecret(rank) and rank > 0 then
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

--- Runs one part of a snapshot; a client that errors or hides a table (secret values) costs only that part.
local function safely(read)
  local ok, a, b = pcall(read)
  if ok then
    return a, b
  end
  return nil
end

local function buildSnapshot()
  local name, realm = clean(UnitFullName, "player")
  if not realm or realm == "" then
    realm = clean(GetNormalizedRealmName) or clean(GetRealmName)
  end
  local _, classFile = clean(UnitClass, "player")
  local _, raceFile = clean(UnitRace, "player")
  local talents, talentSource = safely(readTalents)
  return {
    at = clean(time) or 0,
    name = name,
    realm = realm,
    guid = clean(UnitGUID, "player"),
    class = classFile,
    race = raceFile,
    level = clean(UnitLevel, "player"),
    stats = safely(readStats) or {},
    gear = safely(readGear) or {},
    talents = talents or {},
    talentSource = talentSource or "none",
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
  local same = ns.toJson(last) == ns.toJson(snap)
  last.at, snap.at = a, b
  return same
end

function S.take(reason, verbose)
  if ns.inCombat() then
    if verbose then
      say("snapshots wait until you leave combat.")
    end
    return false
  end
  local db = ns.ensureDB()
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
  while #db.snapshots > ns.MAX_SNAPSHOTS do
    table.remove(db.snapshots, 1)
  end
  ns.refreshMachineExport(db)
  if verbose then
    say(string.format("snapshot saved: level %s, %d gear slots.", tostring(snap.level or "?"), #snap.gear))
  end
  return true
end

local pendingSnapshot = false

function S.schedule(reason)
  if pendingSnapshot then
    return
  end
  pendingSnapshot = true
  local run = function()
    pendingSnapshot = false
    S.take(reason, false)
  end
  if not ns.after(2, run) then
    run()
  end
end

-- ---------------------------------------------------------------------------
-- Copy window
-- ---------------------------------------------------------------------------

local exportFrame

function S.showExport()
  if not exportFrame then
    exportFrame = CreateFrame("Frame", "VigilExportFrame", UIParent, ns.BACKDROP_TEMPLATE)
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

  exportFrame.edit:SetText(ns.refreshMachineExport())
  exportFrame.edit:HighlightText()
  exportFrame:Show()
  exportFrame.edit:SetFocus()
end
