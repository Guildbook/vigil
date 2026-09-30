local _, ns = ...

local clean = ns.clean
local L = ns.logging

-- ---------------------------------------------------------------------------
-- Tooltip (minimap button and addon compartment)
-- ---------------------------------------------------------------------------

local tooltipView = {}
local tooltipMeter = {}

--- The damage meter's DPS for the tooltip, only once it reads as a number (out of combat); tooltip lines are
--- measured and compared by the client, so secrets stay out of them.
local function meterDps()
  local m = ns.meter.read(tooltipMeter)
  if m.found and not ns.isSecret(m.dps) and type(m.dps) == "number" then
    return m.dps
  end
  return nil
end

local function addFightLines(tooltip)
  local fight = ns.fight
  if not fight then
    return
  end
  local view = fight.read(tooltipView)
  if view.source == "meter" then
    local dps = meterDps()
    if view.inCombat then
      tooltip:AddLine(" ")
      tooltip:AddDoubleLine("In combat", ns.formatTime(view.elapsed), 1, 0.82, 0, 1, 1, 1)
    elseif dps then
      tooltip:AddLine(" ")
      tooltip:AddDoubleLine("Last fight", ns.formatRate(dps) .. " DPS", 0.8, 0.8, 0.8, 1, 1, 1)
    end
    return
  end
  if view.open and view.available ~= false then
    tooltip:AddLine(" ")
    tooltip:AddDoubleLine(view.label or "Fight", ns.formatTime(view.elapsed), 1, 0.82, 0, 1, 1, 1)
    tooltip:AddDoubleLine("DPS", ns.formatRate(view.dps), 1, 1, 1, 1, 1, 1)
    if view.healing > 0 then
      tooltip:AddDoubleLine("HPS", ns.formatRate(view.hps), 1, 1, 1, 1, 1, 1)
    end
    return
  end
  if view.inCombat then
    tooltip:AddLine(" ")
    tooltip:AddDoubleLine("In combat", ns.formatTime(view.elapsed), 1, 0.82, 0, 1, 1, 1)
    return
  end
  local last = fight.last()
  if last then
    tooltip:AddLine(" ")
    tooltip:AddDoubleLine("Last fight", ns.formatTime(last.duration), 0.8, 0.8, 0.8, 0.8, 0.8, 0.8)
    tooltip:AddDoubleLine(last.label, ns.formatRate(last.dps) .. " DPS", 1, 1, 1, 1, 1, 1)
  end
end

local function showTooltip(owner, draggable)
  local tooltip = GameTooltip
  if owner then
    tooltip:SetOwner(owner, "ANCHOR_NONE")
    tooltip:ClearAllPoints()
    local point, relativePoint = ns.ui.tooltipAnchor(owner)
    tooltip:SetPoint(point, owner, relativePoint)
  else
    tooltip:SetOwner(UIParent, "ANCHOR_CURSOR")
  end
  tooltip:AddDoubleLine("Vigil", "v" .. ns.version, 1, 0.82, 0, 0.6, 0.6, 0.6)
  if L.available() then
    local text, r, g, b = L.label()
    tooltip:AddDoubleLine("Combat logging", text, 1, 1, 1, r, g, b)
    if L.pendingIndicator() then
      tooltip:AddLine("Updating...", 1, 0.82, 0)
    elseif L.note() then
      tooltip:AddLine(L.note(), 1, 0.7, 0.3, true)
    end
  else
    tooltip:AddLine("Combat logging: type /combatlog in chat", 1, 1, 1)
  end
  pcall(addFightLines, tooltip)
  tooltip:AddLine(" ")
  tooltip:AddLine("Left-click: settings", 0.6, 0.6, 0.6)
  tooltip:AddLine("Right-click: toggle combat logging", 0.6, 0.6, 0.6)
  if draggable then
    tooltip:AddLine("Drag: move", 0.6, 0.6, 0.6)
  end
  tooltip:Show()
end
ns.showTooltip = showTooltip

-- ---------------------------------------------------------------------------
-- Minimap button (self-contained; same geometry and behaviour as LibDBIcon)
-- ---------------------------------------------------------------------------

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
  local angle = math.rad(ns.ensureDB().minimap.minimapPos)
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
  if not mx or not px or not scale or scale == 0 or not atan2 then
    return
  end
  px, py = px / scale, py / scale
  ns.ensureDB().minimap.minimapPos = math.deg(atan2(py - my, px - mx)) % 360
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
  icon:SetTexture(ns.ICON)
  local iconPoint, iconX, iconY
  if ns.IS_MAINLINE then
    overlay:SetSize(50, 50)
    overlay:SetPoint("TOPLEFT")
    background:SetSize(24, 24)
    background:SetPoint("CENTER", 0, 1)
    icon:SetSize(18, 18)
    iconPoint, iconX, iconY = "CENTER", 0, 1
  else
    overlay:SetSize(53, 53)
    overlay:SetPoint("TOPLEFT")
    background:SetSize(20, 20)
    background:SetPoint("TOPLEFT", 7, -5)
    icon:SetSize(17, 17)
    iconPoint, iconX, iconY = "TOPLEFT", 7, -6
  end
  icon:SetPoint(iconPoint, iconX, iconY)
  -- Texture coordinates can't change once a mask is set (a Lua error on modern clients), so the pressed look
  -- nudges the icon instead of cropping it.
  if icon.SetMask then
    pcall(icon.SetMask, icon, "Interface\\CharacterFrame\\TempPortraitAlphaMask")
  end
  button.icon = icon
  local function pressIcon(pressed)
    icon:ClearAllPoints()
    if pressed then
      icon:SetPoint(iconPoint, iconX + 1, iconY - 1)
    else
      icon:SetPoint(iconPoint, iconX, iconY)
    end
  end

  button:SetScript("OnEnter", function(self)
    if not self.isMoving then
      showTooltip(self, true)
    end
  end)
  button:SetScript("OnLeave", function()
    GameTooltip:Hide()
  end)
  button:SetScript("OnMouseDown", function()
    pressIcon(true)
  end)
  button:SetScript("OnMouseUp", function()
    pressIcon(false)
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
    pressIcon(false)
  end)
  button:SetScript("OnClick", function(self, mouseButton)
    if mouseButton == "RightButton" then
      L.toggle()
    else
      ns.togglePanel()
    end
    if GameTooltip:IsOwned(self) then
      showTooltip(self, true)
    end
  end)

  minimapButton = button
  return button
end

function ns.applyMinimapVisibility()
  if ns.ensureDB().minimap.hide then
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

function ns.setMinimapHidden(hide)
  ns.ensureDB().minimap.hide = hide and true or false
  ns.applyMinimapVisibility()
  ns.refreshPanel()
end

--- Keeps an open minimap tooltip current (logging state, fight DPS).
function ns.refreshMinimapTooltip()
  if minimapButton and not minimapButton.isMoving and GameTooltip:IsOwned(minimapButton) then
    showTooltip(minimapButton, true)
  end
end

-- Addon compartment (retail-style clients read these names from the TOC; other clients ignore them).
function Vigil_OnAddonCompartmentClick(_, mouseButton)
  if mouseButton == "RightButton" then
    L.toggle()
  else
    ns.togglePanel()
  end
end

function Vigil_OnAddonCompartmentEnter(_, menuButtonFrame)
  showTooltip(type(menuButtonFrame) == "table" and menuButtonFrame.GetCenter and menuButtonFrame or nil, false)
end

function Vigil_OnAddonCompartmentLeave()
  GameTooltip:Hide()
end
