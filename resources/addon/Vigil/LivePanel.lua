local _, ns = ...

local clean = ns.clean
local addText, textHeight = ns.ui.addText, ns.ui.textHeight

--[[
  The live panel: the fight in progress (target or boss, time, damage, DPS, idle), then the last fight's summary
  until the next pull. Refreshed four times a second from a timer, never per combat event.

  Where the client withholds combat events it shows the game's damage meter for the current session instead
  (Meter.lua). Those numbers are secret in combat: they go to SetText through ns.meter.amountText and
  ns.meter.rateText, never compared.
]]

local P = {}
ns.livePanel = P

local WIDTH = 236
local PAD = 10
local PORTRAIT = 32
local LABEL_WIDTH = 78
local INNER = WIDTH - 2 * PAD
local REFRESH = 0.25
local ROWS = 6

local NO_EVENTS = "This client keeps combat events from addons; damage shows in the desktop app."
local METER_OFF = "Turn on the game's damage meter in its options to see your numbers here."

local frame
local view = {}
local meterView = {}
local isSecret = ns.isSecret

local function store()
  return ns.ensureDB().live
end

local function create()
  local f = ns.ui.createBackdropFrame("VigilLivePanel", UIParent, "tooltip")
  f:SetSize(WIDTH, 120)
  f:SetFrameStrata("MEDIUM")
  f:Hide()
  ns.ui.makeMovable(f, store)
  f:SetScript("OnMouseUp", function(_, button)
    if button == "RightButton" then
      ns.togglePanel()
    end
  end)
  f:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_NONE")
    local point, relativePoint = ns.ui.tooltipAnchor(self)
    GameTooltip:SetPoint(point, self, relativePoint)
    GameTooltip:AddLine("Vigil live panel", 1, 0.82, 0)
    GameTooltip:AddLine("Drag to move. Right-click for settings.", 0.8, 0.8, 0.8, true)
    GameTooltip:Show()
  end)
  f:SetScript("OnLeave", function()
    GameTooltip:Hide()
  end)

  local portrait = f:CreateTexture(nil, "ARTWORK")
  portrait:SetSize(PORTRAIT, PORTRAIT)
  portrait:SetPoint("TOPLEFT", f, "TOPLEFT", PAD, -PAD)
  f.portrait = portrait

  f.title = addText(f, "GameFontNormal", INNER - PORTRAIT - 6)
  f.subtitle = addText(f, "GameFontDisableSmall", INNER - PORTRAIT - 6)

  f.rows = {}
  for i = 1, ROWS do
    local label = addText(f, "GameFontDisableSmall", LABEL_WIDTH)
    local value = addText(f, "GameFontHighlightSmall", INNER - LABEL_WIDTH)
    value:SetJustifyH("RIGHT")
    f.rows[i] = { label = label, value = value }
  end

  f.callout = addText(f, "GameFontNormalSmall", INNER)
  f.callout:SetTextColor(1, 0.7, 0.3)
  f.note = addText(f, "GameFontDisableSmall", INNER)
  f.tail = { f.callout, f.note }
  return f
end

local rowCount = 0

local function setRow(label, value)
  rowCount = rowCount + 1
  local row = frame.rows[rowCount]
  row.label:SetText(label)
  row.value:SetText(value)
end

local function layout()
  local f = frame
  local textWidth = INNER - PORTRAIT - 6
  f.title:ClearAllPoints()
  f.title:SetPoint("TOPLEFT", f, "TOPLEFT", PAD + PORTRAIT + 6, -PAD)
  f.title:SetWidth(textWidth)
  local headerText = textHeight(f.title)
  f.subtitle:ClearAllPoints()
  f.subtitle:SetPoint("TOPLEFT", f.title, "BOTTOMLEFT", 0, -2)
  if (f.subtitle:GetText() or "") ~= "" then
    headerText = headerText + 2 + textHeight(f.subtitle)
  end
  local y = PAD + math.max(PORTRAIT, headerText) + 6
  for i = 1, ROWS do
    local row = f.rows[i]
    if i <= rowCount then
      row.label:ClearAllPoints()
      row.label:SetPoint("TOPLEFT", f, "TOPLEFT", PAD, -y)
      row.value:ClearAllPoints()
      row.value:SetPoint("TOPLEFT", f, "TOPLEFT", PAD + LABEL_WIDTH, -y)
      row.label:Show()
      row.value:Show()
      y = y + math.max(textHeight(row.label), textHeight(row.value)) + 3
    else
      row.label:Hide()
      row.value:Hide()
    end
  end
  for _, fs in ipairs(f.tail) do
    if (fs:GetText() or "") ~= "" then
      y = y + 3
      fs:ClearAllPoints()
      fs:SetPoint("TOPLEFT", f, "TOPLEFT", PAD, -y)
      fs:Show()
      y = y + textHeight(fs)
    else
      fs:Hide()
    end
  end
  f:SetHeight(math.ceil(y + PAD))
end

local function setPortrait(boss)
  local tex = frame.portrait
  local target = clean(UnitExists, "target") and not clean(UnitIsPlayer, "target")
  if target and type(SetPortraitTexture) == "function" and (not boss or ns.intel.fromUnit("target") == boss) then
    tex:SetTexCoord(0, 1, 0, 1)
    SetPortraitTexture(tex, "target")
    return
  end
  if boss and boss.a and boss.a[1] then
    local ability = boss.a[1]
    tex:SetTexture(ns.spellTexture(ability.id and ability.id[1], ability.ic))
  else
    tex:SetTexture(ns.ICON)
  end
  tex:SetTexCoord(0.07, 0.93, 0.07, 0.93)
end

local function idleText(v)
  if v.idle <= 0 then
    return "none"
  end
  return string.format("%s total", ns.formatSeconds(v.idle))
end

local function shouldShow(v)
  local db = store()
  if not db.shown then
    return false
  end
  if db.hideOutOfCombat and not v.inCombat and not v.open then
    return false
  end
  return true
end

--- An amount from the meter worth a row: found, and either secret (unknowable, so shown) or above zero.
local function worthShowing(found, amount)
  if not found then
    return false
  end
  if isSecret(amount) then
    return true
  end
  return type(amount) == "number" and amount > 0
end

local function targetName()
  if clean(UnitExists, "target") and not clean(UnitIsPlayer, "target") then
    return clean(UnitName, "target")
  end
  return nil
end

--- The damage meter's current session: your damage, DPS and healing, displayed without arithmetic.
local function showMeter(v)
  local m = ns.meter.read(meterView)
  local boss = v.open and v.boss or nil
  if not m.found and not v.inCombat then
    frame.title:SetText("Vigil")
    frame.subtitle:SetText("Waiting for a fight")
    setPortrait(nil)
    frame.note:SetText(ns.meter.switchedOff() and METER_OFF or "")
    return nil
  end
  frame.title:SetText((boss and boss.n) or (v.open and v.encounter and v.label) or targetName() or "Fight")
  if boss then
    local instance = ns.intel.instanceName(boss)
    frame.subtitle:SetText(instance ~= "" and instance or "Boss")
  else
    frame.subtitle:SetText(v.inCombat and "In combat" or "Last fight")
  end
  setPortrait(boss)
  if m.duration then
    setRow("Time", ns.formatTime(m.duration))
  elseif v.inCombat then
    setRow("Time", ns.formatTime(v.elapsed))
  end
  if m.found then
    setRow("Damage", ns.meter.amountText(m.damage))
    setRow("DPS", ns.meter.rateText(m.dps))
  end
  if worthShowing(m.healFound, m.healing) then
    setRow("Healing", ns.meter.amountText(m.healing))
    setRow("HPS", ns.meter.rateText(m.hps))
  end
  frame.note:SetText(not m.found and ns.meter.switchedOff() and METER_OFF or "")
  return v.inCombat and ns.callouts.text(v) or nil
end

function P.refresh()
  if not frame then
    return
  end
  local fight = ns.fight
  local v = fight.read(view)
  if not shouldShow(v) then
    frame:Hide()
    return
  end
  rowCount = 0
  local callout
  if v.open and v.available ~= false then
    local boss = v.boss
    frame.title:SetText(v.label or "Fight")
    if boss then
      local instance = ns.intel.instanceName(boss)
      frame.subtitle:SetText(instance ~= "" and instance or "Boss")
    else
      frame.subtitle:SetText(v.inCombat and "In combat" or "Fight ending")
    end
    setPortrait(boss)
    setRow("Time", ns.formatTime(v.elapsed))
    setRow("Damage", ns.formatNumber(v.damage))
    setRow("DPS", ns.formatRate(v.dps))
    setRow("Idle", idleText(v))
    if v.healing > 0 then
      setRow("Healing", string.format("%s (%s HPS)", ns.formatNumber(v.healing), ns.formatRate(v.hps)))
    end
    if v.taken > 0 then
      setRow("Taken", ns.formatNumber(v.taken))
    end
    callout = ns.callouts.text(v)
    frame.note:SetText("")
  elseif v.source == "meter" then
    callout = showMeter(v)
  elseif v.available == false and v.inCombat then
    frame.title:SetText(targetName() or "In combat")
    frame.subtitle:SetText("In combat")
    setPortrait(nil)
    setRow("Time", ns.formatTime(v.elapsed))
    callout = ns.callouts.text(v)
    frame.note:SetText(NO_EVENTS)
  else
    local last = fight.last()
    if last then
      frame.title:SetText(last.label)
      frame.subtitle:SetText("Last fight")
      setPortrait(last.boss and ns.intel.byKey(last.boss) or nil)
      setRow("Time", ns.formatTime(last.duration))
      setRow("Damage", ns.formatNumber(last.damage + last.petDamage))
      setRow("DPS", ns.formatRate(last.dps))
      setRow("Active", string.format("%d%%", math.floor(100 * last.active / math.max(0.001, last.duration) + 0.5)))
      if last.idle > 0 then
        setRow("Idle", string.format("%s, longest %s", ns.formatSeconds(last.idle), ns.formatSeconds(last.longestIdle)))
      end
      if last.healing + last.petHealing > 0 then
        setRow("Healing", string.format("%s (%s HPS)", ns.formatNumber(last.healing + last.petHealing), ns.formatRate(last.hps)))
      end
    else
      frame.title:SetText("Vigil")
      frame.subtitle:SetText("Waiting for a fight")
      setPortrait(nil)
    end
    frame.note:SetText(v.available == false and NO_EVENTS or "")
  end
  frame.callout:SetText(callout or "")
  layout()
  frame:Show()
end

--- Scale, lock and visibility from the settings.
function P.apply()
  if not frame then
    return
  end
  local db = store()
  frame:SetScale(db.scale)
  frame:EnableMouse(not db.locked)
  P.refresh()
end

function P.resetPosition()
  local db = store()
  db.point = nil
  if frame then
    ns.ui.restorePosition(frame, db, "CENTER", 260, -120)
  end
end

local ticks = 0

local function tick()
  ns.fight.tick()
  P.refresh()
  ticks = ticks + 1
  if ticks % 4 == 0 then
    ns.refreshMinimapTooltip()
  end
end

function P.init()
  frame = frame or create()
  ns.ui.restorePosition(frame, store(), "CENTER", 260, -120)
  P.apply()
  local ticking = ns.every(REFRESH, tick) and true or false
  if not ticking then
    -- No timers on this client: refresh on combat changes only.
    ns.listen("FIGHT_START", P.refresh)
    ns.listen("FIGHT_END", P.refresh)
    ns.listen("COMBAT", P.refresh)
  end
  ns.listen("SETTINGS", P.apply)
  ns.listen("FIGHT_END", P.refresh)
  if ns.meter.exists() then
    -- Session updates come many times a second in combat; the timer already covers them when there is one.
    local onMeter = function(event)
      if ns.fight.available == false and (not ticking or event ~= "DAMAGE_METER_COMBAT_SESSION_UPDATED") then
        P.refresh()
      end
    end
    for _, event in ipairs(ns.meter.EVENTS) do
      ns.on(event, onMeter)
    end
  end
end
