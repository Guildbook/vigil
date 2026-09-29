local _, ns = ...

local clean, isSecret = ns.clean, ns.isSecret

--[[
  Boss intel from Data/Bosses.lua (generated from the desktop app's src/data). A unit is a known boss by the NPC ID
  in its GUID or, when the ID is missing or wrong, by name. The intel panel shows the boss you target or fight,
  or the one you looked up with /vigil intel.
]]

local I = {}
ns.intel = I

local byNpc, byName, byEncounter, byKey = {}, {}, {}, {}
local bosses = (ns.data and ns.data.bosses) or {}
local instances = (ns.data and ns.data.instances) or {}

for _, boss in ipairs(bosses) do
  byKey[boss.k] = boss
  byName[string.lower(boss.n)] = byName[string.lower(boss.n)] or boss
  if boss.u then
    for _, name in ipairs(boss.u) do
      byName[string.lower(name)] = byName[string.lower(name)] or boss
    end
  end
  if boss.ids then
    for _, id in ipairs(boss.ids) do
      byNpc[id] = byNpc[id] or boss
    end
  end
  if boss.e then
    for _, id in ipairs(boss.e) do
      byEncounter[id] = byEncounter[id] or boss
    end
  end
end

I.count = #bosses

function I.forUnit(npcId, name)
  local boss = type(npcId) == "number" and not isSecret(npcId) and byNpc[npcId]
  if boss then
    return boss
  end
  if type(name) == "string" and not isSecret(name) and name ~= "" then
    return byName[string.lower(name)]
  end
  return nil
end

function I.forEncounter(encounterId)
  if isSecret(encounterId) or type(encounterId) ~= "number" then
    return nil
  end
  return byEncounter[encounterId]
end

function I.byKey(key)
  return byKey[key]
end

function I.instanceName(boss)
  local instance = boss and instances[boss.i]
  return instance and instance.n or ""
end

--- The boss a unit token ("target", "boss1") is, if any. Players and pets are never bosses. The 12.x engine can
--- make an enemy's GUID and name secret; `clean` drops those, so the name is the fallback for a secret GUID, and
--- ENCOUNTER_START (and /vigil intel) the fallback when both are secret.
function I.fromUnit(unit)
  if not clean(UnitExists, unit) or clean(UnitIsPlayer, unit) then
    return nil
  end
  return I.forUnit(ns.npcIdFromGuid(clean(UnitGUID, unit)), clean(UnitName, unit))
end

local function fold(s)
  s = string.lower(s or "")
  s = s:gsub("\226\128\153", ""):gsub("'", "")
  s = s:gsub("[^%w]+", " ")
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

--- Bosses matching every word of `query` in their name, other unit names or instance, best match first.
function I.search(query)
  local words = {}
  for word in fold(query):gmatch("%S+") do
    table.insert(words, word)
  end
  if #words == 0 then
    return {}
  end
  local hits = {}
  local exact = fold(query)
  for _, boss in ipairs(bosses) do
    local instance = instances[boss.i]
    local hay = fold(boss.n .. " " .. table.concat(boss.u or {}, " ") .. " " .. boss.i .. " "
      .. (instance and (instance.n .. " " .. instance.s) or ""))
    local all = true
    for _, word in ipairs(words) do
      if not hay:find(word, 1, true) then
        all = false
        break
      end
    end
    if all then
      table.insert(hits, { boss = boss, score = fold(boss.n) == exact and 0 or 1 })
    end
  end
  table.sort(hits, function(a, b)
    if a.score ~= b.score then
      return a.score < b.score
    end
    return a.boss.n < b.boss.n
  end)
  local out = {}
  for i, hit in ipairs(hits) do
    out[i] = hit.boss
  end
  return out
end

-- ---------------------------------------------------------------------------
-- The boss on display
-- ---------------------------------------------------------------------------

I.current = nil -- the boss shown
I.source = nil -- "target", "fight", "encounter" or "lookup"
local hideToken = 0
local HIDE_DELAY = 8

local function publish(boss, source)
  hideToken = hideToken + 1
  if I.current == boss and I.source == source then
    return
  end
  I.current, I.source = boss, source
  ns.emit("INTEL", boss, source)
end

--- Shows `boss` from the client (target, fight, encounter). A lookup stays until closed.
function I.offer(boss, source)
  if not boss then
    return
  end
  if I.source == "lookup" and I.current ~= boss then
    return
  end
  if not ns.ensureDB().intel.enabled and source ~= "lookup" then
    return
  end
  publish(boss, source)
end

function I.lookup(boss)
  publish(boss, "lookup")
end

function I.close()
  publish(nil, nil)
end

--- Out of combat with no boss targeted: hide the automatic intel a little later.
local function scheduleHide()
  if not I.current or I.source == "lookup" then
    return
  end
  hideToken = hideToken + 1
  local token = hideToken
  local check = function()
    if token ~= hideToken or I.source == "lookup" then
      return
    end
    if ns.inCombat() or (ns.fight and ns.fight.isOpen()) or I.fromUnit("target") == I.current then
      return
    end
    publish(nil, nil)
  end
  if not ns.after(HIDE_DELAY, check) then
    check()
  end
end

function I.onTargetChanged()
  local boss = I.fromUnit("target")
  if boss then
    I.offer(boss, "target")
  elseif not ns.inCombat() then
    scheduleHide()
  end
end

function I.onEncounterStart(encounterId, name)
  I.offer(I.forEncounter(encounterId) or I.forUnit(nil, name), "encounter")
end

--- A boss seen in the fight's combat events (a new unit the player fought).
function I.onFightUnit(boss)
  if I.current ~= boss then
    I.offer(boss, "fight")
  end
end

I.scheduleHide = scheduleHide
