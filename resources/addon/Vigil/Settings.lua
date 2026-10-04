local _, ns = ...

local L = ns.logging
local addText, textHeight = ns.ui.addText, ns.ui.textHeight

local PANEL_WIDTH = 640
local PANEL_PAD = 22
local COLUMN_GAP = 24
local COLUMN_WIDTH = (PANEL_WIDTH - 2 * PANEL_PAD - COLUMN_GAP) / 2
local TOGGLE_WIDTH = 96
local CHECK_SIZE = 24
local STEP_BUTTON = 22
local panel

local function addCheckbox(parent, label, get, set)
  local check = CreateFrame("CheckButton", nil, parent, "UICheckButtonTemplate")
  check:SetSize(CHECK_SIZE, CHECK_SIZE)
  local labelWidth = COLUMN_WIDTH - CHECK_SIZE - 2
  local text = addText(check, "GameFontHighlight", labelWidth)
  text:SetPoint("TOPLEFT", check, "TOPRIGHT", 2, -6)
  text:SetText(label)
  check.label = text
  check.get = get
  check:SetHitRectInsets(0, -labelWidth, 0, 0)
  check:SetScript("OnClick", function(self)
    set(self:GetChecked() and true or false)
    ns.emit("SETTINGS")
    ns.refreshPanel()
  end)
  return check
end

--- "Label   [-] value [+]": a number setting without the slider templates, which differ between clients.
local function addStepper(parent, label, get, set, step, low, high, format)
  local row = CreateFrame("Frame", nil, parent)
  row:SetSize(COLUMN_WIDTH, STEP_BUTTON)
  local valueWidth = 48
  local text = addText(row, "GameFontHighlight", COLUMN_WIDTH - 2 * STEP_BUTTON - valueWidth - 8)
  text:SetPoint("LEFT", row, "LEFT", 4, 0)
  text:SetText(label)
  row.label = text
  local plus = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
  plus:SetSize(STEP_BUTTON, STEP_BUTTON)
  plus:SetPoint("RIGHT", row, "RIGHT", 0, 0)
  plus:SetText("+")
  local value = row:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  value:SetWidth(valueWidth)
  value:SetJustifyH("CENTER")
  value:SetPoint("RIGHT", plus, "LEFT", -2, 0)
  local minus = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
  minus:SetSize(STEP_BUTTON, STEP_BUTTON)
  minus:SetPoint("RIGHT", value, "LEFT", -2, 0)
  minus:SetText("-")
  local function change(delta)
    local v = math.floor((get() + delta) / step + 0.5) * step
    v = math.max(low, math.min(high, v))
    set(v)
    ns.emit("SETTINGS")
    ns.refreshPanel()
  end
  plus:SetScript("OnClick", function()
    change(step)
  end)
  minus:SetScript("OnClick", function()
    change(-step)
  end)
  row.refresh = function()
    value:SetText(format(get()))
  end
  return row
end

local function percent(v)
  return string.format("%d%%", math.floor(v * 100 + 0.5))
end

local function seconds(v)
  return string.format("%.1f s", v)
end

--- Stacks one column's rows top to bottom and returns the height used.
local function layoutColumn(f, rows, x, y)
  for _, row in ipairs(rows) do
    local region, kind = row[1], row[2]
    local visible = true
    if kind == "note" then
      visible = (region:GetText() or "") ~= ""
    end
    region:ClearAllPoints()
    if not visible then
      region:SetPoint("TOPLEFT", f, "TOPLEFT", x, -y)
    elseif kind == "header" then
      y = y + 6
      region:SetPoint("TOPLEFT", f, "TOPLEFT", x, -y)
      y = y + textHeight(region) + 6
    elseif kind == "check" then
      region:SetPoint("TOPLEFT", f, "TOPLEFT", x - 4, -y)
      y = y + math.max(CHECK_SIZE, textHeight(region.label) + 8) + 2
    elseif kind == "stepper" then
      region:SetPoint("TOPLEFT", f, "TOPLEFT", x, -y)
      y = y + math.max(STEP_BUTTON, textHeight(region.label)) + 6
    elseif kind == "status" then
      region:SetPoint("TOPLEFT", f, "TOPLEFT", x, -(y + 4))
      f.toggle:ClearAllPoints()
      f.toggle:SetPoint("TOPLEFT", f, "TOPLEFT", x + COLUMN_WIDTH - TOGGLE_WIDTH, -y)
      y = y + math.max(textHeight(region) + 4, f.toggle:GetHeight()) + 8
    else
      region:SetPoint("TOPLEFT", f, "TOPLEFT", x, -y)
      y = y + textHeight(region) + 6
    end
  end
  return y
end

local function layoutPanel(f)
  local top = 50
  local left = layoutColumn(f, f.left, PANEL_PAD, top)
  local right = layoutColumn(f, f.right, PANEL_PAD + COLUMN_WIDTH + COLUMN_GAP, top)
  local y = math.max(left, right) + 8
  f.footer:ClearAllPoints()
  f.footer:SetPoint("TOPLEFT", f, "TOPLEFT", PANEL_PAD, -y)
  y = y + textHeight(f.footer) + PANEL_PAD
  f:SetHeight(math.ceil(y))
end

local function header(f, text)
  local fs = addText(f, "GameFontNormal", COLUMN_WIDTH)
  fs:SetText(text)
  return { fs, "header" }
end

local function createPanel()
  local db = ns.ensureDB
  local f = ns.ui.createBackdropFrame("VigilPanel", UIParent, "dialog")
  f:SetSize(PANEL_WIDTH, 400)
  f:SetPoint("CENTER", 0, 60)
  f:SetFrameStrata("DIALOG")
  f:SetToplevel(true)
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", f.StopMovingOrSizing)
  f:Hide()
  if type(UISpecialFrames) == "table" then
    table.insert(UISpecialFrames, "VigilPanel")
  end

  local icon = f:CreateTexture(nil, "ARTWORK")
  icon:SetTexture(ns.ICON)
  icon:SetSize(20, 20)
  icon:SetPoint("TOPLEFT", PANEL_PAD - 2, -18)

  local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  title:SetPoint("LEFT", icon, "RIGHT", 6, 0)
  title:SetText("Vigil")

  local version = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  version:SetPoint("BOTTOMLEFT", title, "BOTTOMRIGHT", 6, 1)
  version:SetText("v" .. ns.version)

  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -4, -4)

  -- Combat logging (left column)
  f.status = addText(f, "GameFontHighlight", COLUMN_WIDTH - TOGGLE_WIDTH - 8)

  local toggle = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
  toggle:SetSize(TOGGLE_WIDTH, 22)
  toggle:SetScript("OnClick", L.toggle)
  f.toggle = toggle

  -- Shown only when a change is still pending after a moment. StreamCircle ships with every client Vigil
  -- supports (Details uses it the same way); without animations it just shows static.
  local spinner = CreateFrame("Frame", nil, toggle)
  spinner:SetSize(16, 16)
  spinner:SetPoint("LEFT", toggle, "LEFT", 5, 0)
  spinner:SetFrameLevel(toggle:GetFrameLevel() + 2)
  local ring = spinner:CreateTexture(nil, "OVERLAY")
  ring:SetTexture("Interface\\COMMON\\StreamCircle")
  ring:SetAllPoints()
  if spinner.CreateAnimationGroup then
    local ok, group = pcall(spinner.CreateAnimationGroup, spinner)
    local rotation = ok and group and group:CreateAnimation("Rotation")
    if rotation then
      rotation:SetDegrees(-360)
      rotation:SetDuration(1)
      group:SetLooping("REPEAT")
      spinner.anim = group
    end
  end
  spinner:Hide()
  f.spinner = spinner

  f.note = addText(f, "GameFontNormalSmall", COLUMN_WIDTH)
  f.advanced = addText(f, "GameFontDisableSmall", COLUMN_WIDTH)
  f.zone = addText(f, "GameFontHighlightSmall", COLUMN_WIDTH)
  f.calloutNote = addText(f, "GameFontDisableSmall", COLUMN_WIDTH)

  local checks = {}
  local function check(label, get, set)
    local c = addCheckbox(f, label, get, set)
    table.insert(checks, c)
    return { c, "check" }
  end
  local steppers = {}
  local function stepper(...)
    local s = addStepper(f, ...)
    table.insert(steppers, s)
    return { s, "stepper" }
  end

  f.left = {
    header(f, "Combat logging"),
    { f.status, "status" },
    { f.note, "note" },
    { f.advanced, "text" },
    { f.zone, "text" },
    check("Keep combat logging on at every login", function()
      return db().settings.autoLog
    end, function(on)
      db().settings.autoLog = on
      if on then
        L.clearInstanceFlag()
        if not L.isOn() then
          L.request(true)
        end
      end
    end),
    check("Keep Advanced Combat Logging on", function()
      return db().settings.autoAdvanced
    end, function(on)
      db().settings.autoAdvanced = on
      if on then
        L.ensureAdvanced()
      end
    end),
    check("Turn combat logging on in dungeons and raids", function()
      return db().settings.autoLogInstances
    end, function(on)
      db().settings.autoLogInstances = on
      if on and L.instanceKey() then
        L.logForInstance()
      end
    end),
    check("Show minimap button", function()
      return not db().minimap.hide
    end, function(on)
      ns.setMinimapHidden(not on)
    end),
  }

  f.right = {
    header(f, "Live panel"),
    check("Show the live fight panel", function()
      return db().live.shown
    end, function(on)
      db().live.shown = on
    end),
    check("Only show it in combat", function()
      return db().live.hideOutOfCombat
    end, function(on)
      db().live.hideOutOfCombat = on
    end),
    check("Lock its position", function()
      return db().live.locked
    end, function(on)
      db().live.locked = on
    end),
    stepper("Scale", function()
      return db().live.scale
    end, function(v)
      db().live.scale = v
    end, 0.1, 0.6, 1.6, percent),
    header(f, "Boss intel"),
    check("Show intel for known bosses you target or fight", function()
      return db().intel.enabled
    end, function(on)
      db().intel.enabled = on
      if not on and ns.intel.source ~= "lookup" then
        ns.intel.close()
      end
    end),
    check("Lock its position", function()
      return db().intel.locked
    end, function(on)
      db().intel.locked = on
    end),
    stepper("Scale", function()
      return db().intel.scale
    end, function(v)
      db().intel.scale = v
    end, 0.1, 0.6, 1.6, percent),
    header(f, "Callouts"),
    check("Show callouts in the live panel", function()
      return db().callouts.enabled
    end, function(on)
      db().callouts.enabled = on
    end),
    check("Idle warning", function()
      return db().callouts.idle
    end, function(on)
      db().callouts.idle = on
    end),
    stepper("Idle after", function()
      return db().callouts.idleSeconds
    end, function(v)
      db().callouts.idleSeconds = v
    end, 0.5, 1, 6, seconds),
    check("Self-buff you started the fight with dropped", function()
      return db().callouts.buffs
    end, function(on)
      db().callouts.buffs = on
    end),
    { f.calloutNote, "note" },
  }
  f.checks = checks
  f.steppers = steppers

  f.footer = addText(f, "GameFontDisableSmall", PANEL_WIDTH - 2 * PANEL_PAD)
  f.footer:SetText("Live numbers come from the game as you fight: its combat events, or its damage meter where "
    .. "the client keeps combat events from addons. The Vigil desktop app does the full review and "
    .. "uploads from the combat log, which the game writes to disk in 48 KB batches, so solo fights can reach it "
    .. "minutes later. Type /vigil help for commands.")

  f:SetScript("OnShow", function()
    -- One guarded read picks up a /combatlog typed while the panel was closed; the budget keeps it cheap.
    L.query(false)
    ns.refreshPanel()
    -- String heights can read short on the very first frame a font is drawn; measure again.
    ns.after(0, function()
      if f:IsShown() then
        layoutPanel(f)
      end
    end)
  end)
  return f
end

--- Pure read of cached state and cheap zone/CVar queries; safe to call on any event.
function ns.refreshPanel()
  ns.refreshMinimapTooltip()
  if not panel or not panel:IsShown() then
    return
  end
  if L.available() then
    local text, r, g, b = L.label()
    panel.status:SetText(string.format("Combat logging: |cff%02x%02x%02x%s|r",
      math.floor(r * 255), math.floor(g * 255), math.floor(b * 255), text))
    panel.toggle:SetText(L.isOn() and "Turn off" or "Turn on")
    if L.pendingIndicator() then
      panel.toggle:Disable()
      if not panel.spinner:IsShown() then
        panel.spinner:Show()
        if panel.spinner.anim then
          panel.spinner.anim:Play()
        end
      end
    else
      panel.toggle:Enable()
      if panel.spinner.anim then
        panel.spinner.anim:Stop()
      end
      panel.spinner:Hide()
    end
    local note = L.note()
    panel.note:SetText(note and ("|cffffb24c" .. note .. "|r") or "")
  else
    panel.status:SetText("Combat logging: type /combatlog in chat")
    panel.toggle:SetText("Unavailable")
    panel.toggle:Disable()
    panel.note:SetText("")
  end
  if L.advancedOn() then
    panel.advanced:SetText("Advanced Combat Logging is on.")
  elseif ns.ensureDB().settings.autoAdvanced and ns.clean(InCombatLockdown) then
    panel.advanced:SetText("Advanced Combat Logging turns on when you leave combat.")
  else
    panel.advanced:SetText("|cffffb24cFor the Vigil desktop app, turn on Advanced Combat Logging in System > Network.|r")
  end
  local tracked, name, instanceType = L.trackedInstance()
  if tracked then
    panel.zone:SetText(string.format(
      "In %s: %s (%s)",
      instanceType == "raid" and "a raid" or "a dungeon",
      name ~= "" and name or "unknown",
      L.isOn() and "logging" or "not logging"
    ))
  else
    panel.zone:SetText(string.format("%s: not a dungeon or raid", name ~= "" and name or "This zone"))
  end
  if ns.callouts.idleAvailable() then
    panel.calloutNote:SetText("")
  else
    panel.calloutNote:SetText("This client keeps combat events from addons, so the idle warning is off. The "
      .. "dropped-buff warning works only while the game lets addons read your buffs in combat.")
  end
  for _, check in ipairs(panel.checks) do
    check:SetChecked(check.get() and true or false)
  end
  for _, stepper in ipairs(panel.steppers) do
    stepper.refresh()
  end
  layoutPanel(panel)
end

function ns.togglePanel()
  panel = panel or createPanel()
  if panel:IsShown() then
    panel:Hide()
  else
    panel:Show()
  end
end

--- An entry in the game's own AddOns options that opens the Vigil panel.
function ns.registerOptionsCategory()
  local canvas = CreateFrame("Frame")
  canvas.name = "Vigil"
  local title = canvas:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  title:SetPoint("TOPLEFT", 16, -16)
  title:SetText("Vigil")
  local text = addText(canvas, "GameFontHighlight", 520)
  text:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -10)
  text:SetText("Combat logging, the live fight panel, boss intel and callouts are set in Vigil's own panel.")
  local open = CreateFrame("Button", nil, canvas, "UIPanelButtonTemplate")
  open:SetSize(160, 24)
  open:SetPoint("TOPLEFT", text, "BOTTOMLEFT", 0, -12)
  open:SetText("Open Vigil settings")
  open:SetScript("OnClick", function()
    if not (panel and panel:IsShown()) then
      ns.togglePanel()
    end
  end)
  if type(Settings) == "table" and type(Settings.RegisterCanvasLayoutCategory) == "function" then
    pcall(function()
      local category = Settings.RegisterCanvasLayoutCategory(canvas, "Vigil")
      Settings.RegisterAddOnCategory(category)
    end)
  elseif type(InterfaceOptions_AddCategory) == "function" then
    pcall(InterfaceOptions_AddCategory, canvas)
  end
end
