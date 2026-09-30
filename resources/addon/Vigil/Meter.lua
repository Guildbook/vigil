local _, ns = ...

local isSecret = ns.isSecret

--[[
  The game's own damage meter (C_DamageMeter, the 12.x engine: retail Midnight and the Forever client). Where the
  client keeps combat events from addons, the live panel shows your numbers from here instead.

  C_DamageMeter.GetCombatSessionFromType(sessionType, meterType) returns { combatSources = { source, ... },
  totalAmount, maxAmount, durationSeconds }; each source has isLocalPlayer (never secret), totalAmount and
  amountPerSecond. In combat the amounts are secret values: Vigil passes them to the display (M.amountText,
  M.rateText, FontString:SetText) and never does arithmetic on them or compares them. Out of combat they read as
  numbers.

  Formatting a secret: tainted code may hand secrets to the client's C formatters marked SecretArguments =
  AllowedWhenTainted and to string.format, and gets secret text back. Blizzard_DamageMeter formats both amounts
  with AbbreviateLargeNumbers, which below its first breakpoint (1,000) returns the number unrounded
  ("10.68421052636"), so Vigil first passes AbbreviateNumbers breakpoints of its own that round like
  ns.formatNumber and ns.formatRate, then Blizzard's call, then string.format. Each formatter is tried once on
  plain numbers and skipped when it errors or leaves more than two decimals.
]]

local M = {}
ns.meter = M

local api = type(C_DamageMeter) == "table" and C_DamageMeter or nil
local enum = type(Enum) == "table" and Enum or {}
local sessionTypes = type(enum.DamageMeterSessionType) == "table" and enum.DamageMeterSessionType or {}
local meterTypes = type(enum.DamageMeterType) == "table" and enum.DamageMeterType or {}
local CURRENT = sessionTypes.Current or 1
local DAMAGE = meterTypes.DamageDone or 0
local HEALING = meterTypes.HealingDone or 2

M.EVENTS = { "DAMAGE_METER_COMBAT_SESSION_UPDATED", "DAMAGE_METER_CURRENT_SESSION_UPDATED", "DAMAGE_METER_RESET" }

local function breakpoint(at, abbreviation, significandDivisor, fractionDivisor)
  return {
    breakpoint = at,
    abbreviation = abbreviation,
    significandDivisor = significandDivisor,
    fractionDivisor = fractionDivisor,
    abbreviationIsGlobal = false,
  }
end

-- NumberAbbrevOptions for AbbreviateNumbers, largest breakpoint first; significand x fraction divisor is the
-- breakpoint's order of magnitude.
local AMOUNT_OPTIONS = {
  breakpointData = { breakpoint(1000000, "M", 10000, 100), breakpoint(10000, "K", 100, 10), breakpoint(0, "", 1, 1) },
}
local RATE_OPTIONS = {
  breakpointData = { breakpoint(1000000, "M", 10000, 100), breakpoint(1000, "K", 100, 10), breakpoint(0, "", 0.1, 10) },
}

local function call(name, ...)
  return _G[name](...)
end

local AMOUNT_FORMATTERS = {
  function(n) return call("AbbreviateNumbers", n, AMOUNT_OPTIONS) end,
  function(n) return call("AbbreviateLargeNumbers", n) end,
  function(n) return call("BreakUpLargeNumbers", n) end,
  function(n) return string.format("%.0f", n) end,
}
local RATE_FORMATTERS = {
  function(n) return call("AbbreviateNumbers", n, RATE_OPTIONS) end,
  function(n) return call("AbbreviateLargeNumbers", n) end,
  function(n) return string.format("%.1f", n) end,
}

local AMOUNT_PROBES = { 203, 1234, 12345, 1234567 }
local RATE_PROBES = { 10.68421052636, 1234.5678, 12345.678, 1234567.891 }
local usable = {}

--- The formatter works on this client and rounds: tried once on plain numbers.
local function rounds(format, probes)
  if usable[format] == nil then
    local good = true
    for _, n in ipairs(probes) do
      local ok, text = pcall(format, n)
      if not ok or type(text) ~= "string" or text == "" or text:find("%d%.%d%d%d") then
        good = false
        break
      end
    end
    usable[format] = good
  end
  return usable[format]
end

local function secretText(n, formatters, probes)
  for _, format in ipairs(formatters) do
    if rounds(format, probes) then
      local ok, text = pcall(format, n)
      if ok and text then
        return text
      end
    end
  end
  return n
end

--- Display text for a damage or healing amount that may be secret. A secret result goes only to SetText: never
--- compare or concatenate it.
function M.amountText(n)
  if isSecret(n) then
    return secretText(n, AMOUNT_FORMATTERS, AMOUNT_PROBES)
  end
  return type(n) == "number" and ns.formatNumber(n) or ""
end

--- Display text for a DPS or HPS that may be secret, as M.amountText.
function M.rateText(n)
  if isSecret(n) then
    return secretText(n, RATE_FORMATTERS, RATE_PROBES)
  end
  return type(n) == "number" and ns.formatRate(n) or ""
end

--- The client has the damage meter API.
function M.exists()
  return api ~= nil and type(api.GetCombatSessionFromType) == "function"
end

--- The damage meter can be read on this character (IsDamageMeterAvailable can say no, for example at low level).
function M.available()
  if not M.exists() then
    return false
  end
  if type(api.IsDamageMeterAvailable) == "function" then
    local ok, isAvailable = pcall(api.IsDamageMeterAvailable)
    if ok and not isSecret(isAvailable) and isAvailable == false then
      return false
    end
  end
  return true
end

--- The game's "damage meter enabled" option: false only when it reads as off.
function M.switchedOff()
  local value
  if type(C_CVar) == "table" then
    value = ns.clean(C_CVar.GetCVar, "damageMeterEnabled")
  else
    value = ns.clean(GetCVar, "damageMeterEnabled")
  end
  return value == "0"
end

local function accessible(t)
  if type(t) ~= "table" or isSecret(t) then
    return false
  end
  if type(issecrettable) == "function" and issecrettable(t) then
    return false
  end
  if type(canaccesstable) == "function" and not canaccesstable(t) then
    return false
  end
  return true
end

--- The player's source in the current session of `meterType`: true, total, per second (either may be secret).
local function playerAmounts(meterType)
  local session = api.GetCombatSessionFromType(CURRENT, meterType)
  if not accessible(session) then
    return false
  end
  local sources = session.combatSources
  if not accessible(sources) then
    return false
  end
  for _, source in ipairs(sources) do
    if accessible(source) then
      local me = source.isLocalPlayer
      if not isSecret(me) and me == true then
        return true, source.totalAmount, source.amountPerSecond
      end
    end
  end
  return false
end

--- The current session for the player, written into `out` (reused): found, damage, dps, healFound, healing, hps,
--- and duration (seconds, only when it reads as a number above zero). Amounts may be secret.
function M.read(out)
  out.found, out.damage, out.dps = false, nil, nil
  out.healFound, out.healing, out.hps = false, nil, nil
  out.duration = nil
  if not M.exists() then
    return out
  end
  local ok, found, total, perSecond = pcall(playerAmounts, DAMAGE)
  if ok and found == true then
    out.found, out.damage, out.dps = true, total, perSecond
  end
  ok, found, total, perSecond = pcall(playerAmounts, HEALING)
  if ok and found == true then
    out.healFound, out.healing, out.hps = true, total, perSecond
  end
  if type(api.GetSessionDurationSeconds) == "function" then
    local okDuration, seconds = pcall(api.GetSessionDurationSeconds, CURRENT)
    if okDuration and not isSecret(seconds) and type(seconds) == "number" and seconds > 0 then
      out.duration = seconds
    end
  end
  return out
end
