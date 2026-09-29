local _, ns = ...

--[[
  Small UI helpers shared by the panels. Text always gets an explicit width and wraps, and panels measure their
  text to size themselves, so nothing runs past a frame edge whatever the font or language.
]]

local W = {}
ns.ui = W

--- Left-aligned text that wraps inside a fixed width instead of running past the frame.
function W.addText(parent, template, width)
  local fs = parent:CreateFontString(nil, "OVERLAY", template)
  fs:SetWidth(width)
  fs:SetJustifyH("LEFT")
  fs:SetJustifyV("TOP")
  if fs.SetWordWrap then
    fs:SetWordWrap(true)
  end
  if fs.SetNonSpaceWrap then
    fs:SetNonSpaceWrap(true)
  end
  return fs
end

--- Text holding a secret value (the damage meter in combat) makes the client answer GetText, and possibly the
--- measurements, with secrets too; those count as one line.
function W.textHeight(fs)
  local isSecret = ns.isSecret
  local h = fs:GetStringHeight()
  if isSecret(h) or type(h) ~= "number" then
    h = 0
  end
  if h <= 0 then
    local text = fs:GetText()
    if isSecret(text) or (text or "") ~= "" then
      local _, size = fs:GetFont()
      h = (not isSecret(size) and type(size) == "number") and size or 12
    end
  end
  return math.ceil(h)
end

local BACKDROPS = {
  dialog = {
    bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
    edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
    tile = true,
    tileSize = 32,
    edgeSize = 32,
    insets = { left = 8, right = 8, top = 8, bottom = 8 },
  },
  tooltip = {
    bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
    edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
    tile = true,
    tileSize = 16,
    edgeSize = 16,
    insets = { left = 4, right = 4, top = 4, bottom = 4 },
  },
}

--- A frame with a Blizzard backdrop on every client (BackdropTemplate where it exists, SetBackdrop before).
function W.createBackdropFrame(name, parent, style)
  local f = CreateFrame("Frame", name, parent or UIParent, ns.BACKDROP_TEMPLATE)
  if f.SetBackdrop then
    f:SetBackdrop(BACKDROPS[style] or BACKDROPS.dialog)
    if style == "tooltip" then
      f:SetBackdropColor(0.06, 0.06, 0.08, 0.88)
      f:SetBackdropBorderColor(0.6, 0.6, 0.6, 0.9)
    end
  end
  return f
end

--- Where to anchor a tooltip so it opens away from the nearest screen edges (LibDBIcon's rule).
function W.tooltipAnchor(owner)
  local x, y = owner:GetCenter()
  if not x or not y then
    return "TOPRIGHT", "BOTTOMLEFT"
  end
  local width, height = UIParent:GetWidth(), UIParent:GetHeight()
  local h = (x > width * 2 / 3) and "RIGHT" or (x < width / 3) and "LEFT" or ""
  local v = (y > height / 2) and "TOP" or "BOTTOM"
  return v .. h, (v == "TOP" and "BOTTOM" or "TOP") .. h
end

--- Drag to move while `store.locked` is off; the position is kept in `store.point`.
function W.makeMovable(f, store)
  f:SetMovable(true)
  f:SetClampedToScreen(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self)
    if not store().locked then
      self:StartMoving()
    end
  end)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, relativePoint, x, y = self:GetPoint()
    if point then
      store().point = { point, relativePoint or point, math.floor((x or 0) + 0.5), math.floor((y or 0) + 0.5) }
    end
  end)
end

function W.restorePosition(f, store, point, x, y)
  f:ClearAllPoints()
  local saved = store.point
  if type(saved) == "table" and type(saved[1]) == "string" then
    f:SetPoint(saved[1], UIParent, saved[2] or saved[1], tonumber(saved[3]) or 0, tonumber(saved[4]) or 0)
  else
    f:SetPoint(point, UIParent, point, x, y)
  end
end
