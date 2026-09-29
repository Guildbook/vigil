local _, ns = ...

local clean = ns.clean
local addText, textHeight = ns.ui.addText, ns.ui.textHeight

--[[
  The boss intel panel: the boss's summary and, per ability, its icon, name and what to do about it (hover for
  what it does). Shown for the boss you target or fight, or the one looked up with /vigil intel; collapsible.
]]

local P = {}
ns.intelPanel = P

local WIDTH = 300
local PAD = 10
local PORTRAIT = 36
local ICON = 20
local INNER = WIDTH - 2 * PAD
local ROW_TEXT = INNER - ICON - 6

local frame
local shownBoss

local function store()
  return ns.ensureDB().intel
end

local function abilityTooltip(row)
  local ability = row.ability
  if not ability then
    return
  end
  GameTooltip:SetOwner(row, "ANCHOR_NONE")
  local point, relativePoint = ns.ui.tooltipAnchor(row)
  GameTooltip:SetPoint(point, row, relativePoint)
  GameTooltip:AddLine(ability.n, 1, 0.82, 0)
  if ability.src then
    GameTooltip:AddLine(ability.src, 0.7, 0.7, 0.7)
  end
  GameTooltip:AddLine(ability.d, 1, 1, 1, true)
  GameTooltip:AddLine(ability.t, 0.5, 1, 0.5, true)
  GameTooltip:Show()
end

local function createRow(f)
  local row = CreateFrame("Frame", nil, f)
  row:SetSize(INNER, ICON)
  row:EnableMouse(true)
  row:SetScript("OnEnter", abilityTooltip)
  row:SetScript("OnLeave", function()
    GameTooltip:Hide()
  end)
  row.icon = row:CreateTexture(nil, "ARTWORK")
  row.icon:SetSize(ICON, ICON)
  row.icon:SetPoint("TOPLEFT", row, "TOPLEFT", 0, 0)
  row.icon:SetTexCoord(0.07, 0.93, 0.07, 0.93)
  row.name = addText(row, "GameFontNormalSmall", ROW_TEXT)
  row.name:SetPoint("TOPLEFT", row, "TOPLEFT", ICON + 6, 0)
  row.tip = addText(row, "GameFontHighlightSmall", ROW_TEXT)
  row.tip:SetPoint("TOPLEFT", row.name, "BOTTOMLEFT", 0, -1)
  return row
end

local function create()
  local f = ns.ui.createBackdropFrame("VigilIntelPanel", UIParent, "tooltip")
  f:SetSize(WIDTH, 100)
  f:SetFrameStrata("MEDIUM")
  f:EnableMouse(true)
  f:Hide()
  ns.ui.makeMovable(f, store)

  f.portrait = f:CreateTexture(nil, "ARTWORK")
  f.portrait:SetSize(PORTRAIT, PORTRAIT)
  f.portrait:SetPoint("TOPLEFT", f, "TOPLEFT", PAD, -PAD)

  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetSize(24, 24)
  close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -2, -2)
  close:SetScript("OnClick", function()
    ns.intel.close()
  end)

  local collapse = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
  collapse:SetSize(20, 18)
  collapse:SetPoint("RIGHT", close, "LEFT", -2, 0)
  collapse:SetScript("OnClick", function()
    store().collapsed = not store().collapsed
    P.render()
  end)
  f.collapse = collapse

  local headerWidth = INNER - PORTRAIT - 6 - 48
  f.title = addText(f, "GameFontNormal", headerWidth)
  f.title:SetPoint("TOPLEFT", f, "TOPLEFT", PAD + PORTRAIT + 6, -PAD)
  f.subtitle = addText(f, "GameFontDisableSmall", headerWidth)
  f.subtitle:SetPoint("TOPLEFT", f.title, "BOTTOMLEFT", 0, -2)

  f.summary = addText(f, "GameFontHighlightSmall", INNER)
  f.status = addText(f, "GameFontDisableSmall", INNER)
  f.rows = {}
  return f
end

local function setPortrait(boss)
  local tex = frame.portrait
  if type(SetPortraitTexture) == "function" and ns.intel.fromUnit("target") == boss then
    tex:SetTexCoord(0, 1, 0, 1)
    SetPortraitTexture(tex, "target")
    return
  end
  local first = boss.a and boss.a[1]
  if first then
    tex:SetTexture(ns.spellTexture(first.id and first.id[1], first.ic))
  else
    tex:SetTexture("Interface\\TargetingFrame\\UI-TargetingFrame-Skull")
  end
  tex:SetTexCoord(0.07, 0.93, 0.07, 0.93)
end

local STATUS_TEXT = {
  partial = "More abilities to come for this boss.",
  scaffold = "Abilities for this boss are not written yet.",
}

function P.render()
  if not frame then
    return
  end
  local boss = shownBoss
  if not boss then
    frame:Hide()
    return
  end
  local collapsed = store().collapsed
  frame.collapse:SetText(collapsed and "+" or "-")
  frame.title:SetText(boss.n)
  local instance = ns.intel.instanceName(boss)
  frame.subtitle:SetText(boss.rare and (instance .. ", rare") or instance)
  setPortrait(boss)

  local header = textHeight(frame.title)
  if (frame.subtitle:GetText() or "") ~= "" then
    header = header + 2 + textHeight(frame.subtitle)
  end
  local y = PAD + math.max(PORTRAIT, header) + 8

  local abilities = boss.a or {}
  if collapsed then
    frame.summary:Hide()
    frame.status:Hide()
  else
    frame.summary:SetText(boss.s or "")
    frame.summary:ClearAllPoints()
    frame.summary:SetPoint("TOPLEFT", frame, "TOPLEFT", PAD, -y)
    frame.summary:Show()
    y = y + textHeight(frame.summary) + 8
  end
  for i, ability in ipairs(abilities) do
    local row = frame.rows[i] or createRow(frame)
    frame.rows[i] = row
    if collapsed then
      row:Hide()
    else
      row.ability = ability
      row.icon:SetTexture(ns.spellTexture(ability.id and ability.id[1], ability.ic))
      row.name:SetText(ability.src and (ability.n .. " (" .. ability.src .. ")") or ability.n)
      row.tip:SetText(ability.t or "")
      local h = math.max(ICON, textHeight(row.name) + 1 + textHeight(row.tip))
      row:SetHeight(h)
      row:ClearAllPoints()
      row:SetPoint("TOPLEFT", frame, "TOPLEFT", PAD, -y)
      row:Show()
      y = y + h + 6
    end
  end
  for i = #abilities + 1, #frame.rows do
    frame.rows[i]:Hide()
  end
  if not collapsed then
    local status = STATUS_TEXT[boss.st]
    if status and #abilities > 0 then
      frame.status:SetText(status)
    elseif #abilities == 0 then
      frame.status:SetText(boss.st == "scaffold" and STATUS_TEXT.scaffold or "No special abilities.")
    else
      frame.status:SetText("")
    end
    if (frame.status:GetText() or "") ~= "" then
      frame.status:ClearAllPoints()
      frame.status:SetPoint("TOPLEFT", frame, "TOPLEFT", PAD, -y)
      frame.status:Show()
      y = y + textHeight(frame.status) + 4
    else
      frame.status:Hide()
    end
  end
  frame:SetHeight(math.ceil(y + PAD - 4))
  frame:Show()
end

function P.show(boss)
  shownBoss = boss
  P.render()
end

function P.current()
  return shownBoss
end

function P.apply()
  if not frame then
    return
  end
  local db = store()
  frame:SetScale(db.scale)
  P.render()
end

function P.resetPosition()
  local db = store()
  db.point = nil
  if frame then
    ns.ui.restorePosition(frame, db, "CENTER", -300, 120)
  end
end

function P.init()
  frame = frame or create()
  ns.ui.restorePosition(frame, store(), "CENTER", -300, 120)
  P.apply()
  ns.listen("INTEL", function(boss)
    P.show(boss)
  end)
  ns.listen("SETTINGS", P.apply)
  if clean(UnitExists, "target") then
    ns.intel.onTargetChanged()
  end
end
