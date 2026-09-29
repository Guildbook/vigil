local _, ns = ...

local isSecret = ns.isSecret

--[[
  The game's own damage meter (C_DamageMeter, the 12.x engine: retail Midnight and the Forever client). Where the
  client keeps combat events from addons, the live panel shows your numbers from here instead.

  C_DamageMeter.GetCombatSessionFromType(sessionType, meterType) returns { combatSources = { source, ... },
  totalAmount, maxAmount, durationSeconds }; each source has isLocalPlayer (never secret), totalAmount and
  amountPerSecond. In combat the amounts are secret values: Vigil passes them to the display (ns.displayNumber,
  FontString:SetText) and never does arithmetic on them or compares them. Out of combat they read as numbers.
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
