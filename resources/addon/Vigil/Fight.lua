local _, ns = ...

--[[
  Live fight tracker. The client hands addons every combat event as it happens (COMBAT_LOG_EVENT_UNFILTERED),
  long before WoWCombatLog.txt reaches the disk in 48 KB batches. This follows the desktop engine's rules, so the
  numbers here agree with the report the desktop app builds later:
  - a fight starts at the first hostile exchange: your damage or miss on a hostile NPC, its damage or miss on you,
    or a spell you cast at one; ENCOUNTER_START starts a boss fight;
  - it ends after 6 s without a hostile exchange (60 s in a boss encounter), at ENCOUNTER_END, or when you leave
    combat; trash shorter than 2 s, or where you did nothing, is dropped;
  - DPS is your damage over the time from the first to the last hostile exchange (pets and guardians add theirs);
  - active time is time on the global cooldown or casting (1.5 s per cast, from the cast start); idle gaps are
    stretches of 2.5 s or more off it.

  The event handler runs for every combat event in range of the player, so it only uses upvalue locals, drops
  anything not by or on the player (or a pet or guardian they own) before any work, and allocates nothing per
  event: one small table per new enemy, one summary per finished fight.

  The 12.x engine (retail Midnight, the Forever client) keeps combat events from addons, and trying to register
  for them there can raise ADDON_ACTION_FORBIDDEN (a blocked-action popup) rather than a Lua error. So Vigil
  asks first and registers only when the client has CombatLogGetCurrentEventInfo and does not report the combat
  log as restricted. F.available is nil (unknown) until the first readable event, then true; false once events
  are known to be withheld: not registered, blocked, secret, or a whole combat went by without one. Then the live
  panel reads the game's damage meter (Meter.lua) and encounter events still name boss fights.
]]

local F = {}
ns.fight = F

local isSecret = ns.isSecret
local GetTime = GetTime
local band = bit and bit.band
if not band then
  band = function(a, b)
    local result, value = 0, 1
    while a > 0 and b > 0 do
      if a % 2 == 1 and b % 2 == 1 then
        result = result + value
      end
      a, b, value = math.floor(a / 2), math.floor(b / 2), value * 2
    end
    return result
  end
end
local getEventInfo = type(CombatLogGetCurrentEventInfo) == "function" and CombatLogGetCurrentEventInfo or nil

-- COMBATLOG_OBJECT_* bits.
local MINE = 0x1
local FRIENDLY = 0x10
local HOSTILE = 0x40
local TYPE_PLAYER = 0x400
local TYPE_NPC = 0x800
local OWNED = 0x3000 -- pet or guardian (totems are guardians)

local IDLE_GAP = 6
local BOSS_TIMEOUT = 60
local MIN_DURATION = 2
local GCD = 1.5
local MIN_IDLE = 2.5
local CAST_WINDOW = 10
local MAX_TARGETS = 60
local MAX_HISTORY = 10

-- Sub-event kinds, cheapest checks first: everything up to MISS is a hostile exchange when it involves an enemy.
local SWING, SPELL_DMG, MISS, HEAL, CAST_START, CAST_SUCCESS, AURA_ON, AURA_OFF, AURA_REFRESH, DIED =
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10
F.KIND = { AURA_ON = AURA_ON, AURA_OFF = AURA_OFF, AURA_REFRESH = AURA_REFRESH }

local KIND = {
  SWING_DAMAGE = SWING,
  SPELL_DAMAGE = SPELL_DMG,
  SPELL_PERIODIC_DAMAGE = SPELL_DMG,
  SPELL_BUILDING_DAMAGE = SPELL_DMG,
  RANGE_DAMAGE = SPELL_DMG,
  DAMAGE_SHIELD = SPELL_DMG,
  DAMAGE_SPLIT = SPELL_DMG,
  SWING_MISSED = MISS,
  SPELL_MISSED = MISS,
  SPELL_PERIODIC_MISSED = MISS,
  SPELL_BUILDING_MISSED = MISS,
  RANGE_MISSED = MISS,
  DAMAGE_SHIELD_MISSED = MISS,
  SPELL_HEAL = HEAL,
  SPELL_PERIODIC_HEAL = HEAL,
  SPELL_CAST_START = CAST_START,
  SPELL_CAST_SUCCESS = CAST_SUCCESS,
  SPELL_AURA_APPLIED = AURA_ON,
  SPELL_AURA_REMOVED = AURA_OFF,
  SPELL_AURA_REFRESH = AURA_REFRESH,
  UNIT_DIED = DIED,
}

-- Abilities off the global cooldown (the desktop engine's list), by English name and the client's own.
local OFF_GCD = {
  ["Heroic Strike"] = true,
  ["Cleave"] = true,
  ["Maul"] = true,
  ["Raptor Strike"] = true,
  ["Bloodrage"] = true,
  ["Shield Block"] = true,
  ["Attack"] = true,
  ["Auto Shot"] = true,
  ["Shoot"] = true,
}
for _, spellId in ipairs({ 78, 845, 6807, 2973, 2687, 2565, 6603, 75, 5019 }) do
  local name = ns.spellName(spellId)
  if name then
    OFF_GCD[name] = true
  end
end

-- ---------------------------------------------------------------------------
-- State (upvalues; reset per fight)
-- ---------------------------------------------------------------------------

local playerGUID
local clockOffset -- log timestamp minus GetTime()
local inCombat = false
local combatSince

local open = false
local fStart, fLast = 0, 0
local encounterActive = false
local fEncounterName, fEncounterId
local fBoss
local fDamage, fPetDamage, fHealing, fOverheal, fPetHealing, fTaken, fActions = 0, 0, 0, 0, 0, 0, 0
local cursor, fActive, fIdle, fLongestIdle = 0, 0, 0, 0
local lastGapStart, lastGapLength = 0, 0
local castName, castTs
-- Casts on the global cooldown this fight (reused arrays): when each began and landed.
local castFrom, castAt, castCount = {}, {}, 0
local gapScratch = {}
-- The global cooldown seen in the last fight; the live idle clock uses it until this one ends.
local liveGcd = GCD

local targets = {} -- guid -> { name, npcId, exch, died }
local targetOrder = {}
local targetCount = 0

local history = {}
F.history = history

--- Log time (epoch seconds) for now: from the last combat event's timestamp, or the system clock before any.
local function fightNow()
  local t = GetTime()
  if not clockOffset then
    return ns.clean(time) or 0
  end
  return t + clockOffset
end
F.now = fightNow

--- An NPC that is not friendly (the desktop engine's isHostileNpc): damage and fights count against these.
local function isHostileNpc(guid, flags)
  if not flags or band(flags, FRIENDLY) ~= 0 or band(flags, TYPE_PLAYER) ~= 0 then
    return false
  end
  if band(flags, TYPE_NPC + HOSTILE) ~= 0 then
    return true
  end
  if type(guid) ~= "string" then
    return false
  end
  local head = guid:sub(1, 8)
  return head == "Creature" or guid:sub(1, 7) == "Vehicle"
end

local function resetFight(ts)
  fStart, fLast = ts, ts
  fDamage, fPetDamage, fHealing, fOverheal, fPetHealing, fTaken, fActions = 0, 0, 0, 0, 0, 0, 0
  cursor, fActive, fIdle, fLongestIdle = ts, 0, 0, 0
  lastGapStart, lastGapLength = 0, 0
  castName, castTs = nil, nil
  castCount = 0
  fBoss = nil
  fEncounterName, fEncounterId = nil, nil
  for guid in pairs(targets) do
    targets[guid] = nil
  end
  for i = #targetOrder, 1, -1 do
    targetOrder[i] = nil
  end
  targetCount = 0
end

local function startFight(ts)
  resetFight(ts)
  open = true
  ns.emit("FIGHT_START")
end

--- The unit you exchanged the most damage with, and how many enemies took part.
local function mainTarget()
  local best, bestExch
  for i = 1, #targetOrder do
    local rec = targets[targetOrder[i]]
    if rec and (not bestExch or rec.exch > bestExch) then
      best, bestExch = rec, rec.exch
    end
  end
  return best, targetCount
end

local function fightLabel()
  if fEncounterName then
    return fEncounterName
  end
  local main, count = mainTarget()
  if not main then
    return "Unknown"
  end
  if count > 1 then
    return main.name .. " +" .. (count - 1)
  end
  return main.name
end

local function round1(x)
  return math.floor(x * 10 + 0.5) / 10
end

--- The global cooldown from the fight's fastest back-to-back casts (the desktop engine's observedGcd): the
--- 10th percentile of gaps between 0.9 and 2.5 s, kept within 1 to 1.5 s; 1.5 s with fewer than three gaps.
local function observedGcd()
  local n = 0
  for i = 2, castCount do
    local gap = castAt[i] - castAt[i - 1]
    if gap >= 0.9 and gap <= 2.5 then
      n = n + 1
      gapScratch[n] = gap
    end
  end
  for i = #gapScratch, n + 1, -1 do
    gapScratch[i] = nil
  end
  if n < 3 then
    return GCD
  end
  table.sort(gapScratch)
  local p10 = gapScratch[math.floor(n * 0.1) + 1]
  return math.floor(math.min(GCD, math.max(1, p10)) * 1000 + 0.5) / 1000
end

--- Active time, idle time and the longest idle gap over [fStart, finish] with global cooldown `gcd`.
local function settle(finish, gcd)
  local at, active, idle, longest = fStart, 0, 0, 0
  for i = 1, castCount do
    local from = castFrom[i]
    local to = math.max(castAt[i], from + gcd)
    if from > at then
      local gap = from - at
      if gap >= MIN_IDLE then
        idle = idle + gap
        longest = math.max(longest, gap)
      end
    end
    local a, b = math.max(from, at, fStart), math.min(to, finish)
    if b > a then
      active = active + (b - a)
    end
    if to > at then
      at = to
    end
  end
  if finish - at >= MIN_IDLE then
    idle = idle + (finish - at)
    longest = math.max(longest, finish - at)
  end
  return active, idle, longest
end

local function closeFight(endTs)
  if not open then
    return
  end
  open = false
  local wasEncounter = encounterActive or fEncounterName ~= nil
  encounterActive = false
  if F.available == false then
    -- An encounter bracketed without combat events: nothing measured, so nothing to keep.
    ns.emit("FIGHT_DROPPED")
    return
  end
  local finish = endTs or fLast
  local duration = math.max(0.001, finish - fStart)
  if not wasEncounter and (finish - fStart < MIN_DURATION or fActions == 0) then
    ns.emit("FIGHT_DROPPED")
    return
  end
  local gcd = observedGcd()
  liveGcd = gcd
  local active, idle, longest = settle(finish, gcd)
  local summary = {
    label = fightLabel(),
    kind = wasEncounter and "boss" or "trash",
    boss = fBoss and fBoss.k or nil,
    bossName = fBoss and fBoss.n or nil,
    encounterId = fEncounterId,
    start = fStart,
    duration = round1(duration),
    damage = fDamage,
    petDamage = fPetDamage,
    dps = round1((fDamage + fPetDamage) / duration),
    playerDps = round1(fDamage / duration),
    healing = fHealing,
    petHealing = fPetHealing,
    overheal = fOverheal,
    hps = round1((fHealing + fPetHealing) / duration),
    taken = fTaken,
    active = round1(active),
    idle = round1(idle),
    longestIdle = round1(longest),
    gcd = gcd,
    targets = targetCount,
  }
  table.insert(history, summary)
  while #history > MAX_HISTORY do
    table.remove(history, 1)
  end
  local db = ns.ensureDB()
  table.insert(db.fights, summary)
  while #db.fights > ns.MAX_SAVED_FIGHTS do
    table.remove(db.fights, 1)
  end
  ns.emit("FIGHT_END", summary)
end

--- Time on the global cooldown from a cast: [from, to], merged into the fight's busy time as it arrives.
local function busy(from, to)
  if from < fStart then
    from = fStart
  end
  if to <= cursor then
    return
  end
  if from > cursor then
    local gap = from - cursor
    if gap >= MIN_IDLE then
      fIdle = fIdle + gap
      if gap > fLongestIdle then
        fLongestIdle = gap
      end
    end
    lastGapStart, lastGapLength = cursor, gap
    fActive = fActive + (to - from)
  else
    fActive = fActive + (to - cursor)
  end
  cursor = to
end

local function trackTarget(guid, name, amount)
  local rec = targets[guid]
  if not rec then
    if targetCount >= MAX_TARGETS then
      return
    end
    rec = { name = name or "Unknown", npcId = ns.npcIdFromGuid(guid), exch = 0, died = false }
    targets[guid] = rec
    targetCount = targetCount + 1
    targetOrder[targetCount] = guid
    if not fBoss then
      local boss = ns.intel and ns.intel.forUnit(rec.npcId, name)
      if boss then
        fBoss = boss
        ns.intel.onFightUnit(boss)
        ns.emit("FIGHT_BOSS", boss)
      end
    end
  end
  if amount then
    rec.exch = rec.exch + amount
  end
end

local function handle(ts, sub, _, srcGUID, srcName, srcFlags, _, dstGUID, dstName, dstFlags, _, a12, a13, _, a15, a16)
  local kind = KIND[sub]
  if not kind or not playerGUID then
    return
  end
  local fromMe = srcGUID == playerGUID
  local toMe = dstGUID == playerGUID
  local fromPet = not fromMe and srcFlags ~= nil and band(srcFlags, MINE) ~= 0 and band(srcFlags, OWNED) ~= 0
  if not (fromMe or toMe or fromPet) then
    if kind == DIED and open then
      local rec = targets[dstGUID]
      if rec then
        rec.died = true
      end
    end
    return
  end

  clockOffset = ts - GetTime()
  if open and ts - fLast > (encounterActive and BOSS_TIMEOUT or IDLE_GAP) then
    closeFight(nil)
  end

  if kind >= AURA_ON then
    if kind ~= DIED and toMe then
      local callouts = ns.callouts
      if callouts then
        callouts.onPlayerAura(kind, a13)
      end
    end
    if not (fromMe and open and kind ~= DIED and isHostileNpc(dstGUID, dstFlags)) then
      return
    end
    trackTarget(dstGUID, dstName, nil)
    return
  end

  local hostile = false
  if kind <= MISS then
    if fromMe then
      hostile = isHostileNpc(dstGUID, dstFlags)
    elseif toMe then
      hostile = isHostileNpc(srcGUID, srcFlags)
    end
  elseif kind == CAST_SUCCESS and fromMe then
    hostile = isHostileNpc(dstGUID, dstFlags)
  end

  if not open then
    if not hostile or fromPet then
      return
    end
    startFight(ts)
  end

  local amount
  if kind == SWING then
    amount = a12
  elseif kind == SPELL_DMG or kind == HEAL then
    amount = a15
  end
  if type(amount) ~= "number" then
    amount = 0
  end

  if fromMe then
    if kind <= SPELL_DMG then
      fDamage = fDamage + amount
      if hostile then
        trackTarget(dstGUID, dstName, amount)
      end
    elseif kind == HEAL then
      local over = type(a16) == "number" and a16 or 0
      local effective = amount - over
      if effective > 0 then
        fHealing = fHealing + effective
      end
      fOverheal = fOverheal + over
      fActions = fActions + 1
    elseif kind == CAST_START then
      castName, castTs = a13, ts
    elseif kind == CAST_SUCCESS then
      fActions = fActions + 1
      if not OFF_GCD[a13] then
        local from = ts
        if castName == a13 and castTs and ts - castTs < CAST_WINDOW then
          from = castTs
        end
        castName = nil
        castCount = castCount + 1
        castFrom[castCount], castAt[castCount] = from, ts
        local to = from + liveGcd
        if to < ts then
          to = ts
        end
        busy(from, to)
      end
      if hostile then
        trackTarget(dstGUID, dstName, nil)
      end
    elseif hostile then
      trackTarget(dstGUID, dstName, nil)
    end
    if hostile and kind ~= CAST_SUCCESS then
      fActions = fActions + 1
    end
  elseif fromPet then
    if kind <= SPELL_DMG then
      fPetDamage = fPetDamage + amount
    elseif kind == HEAL then
      local over = type(a16) == "number" and a16 or 0
      if amount > over then
        fPetHealing = fPetHealing + amount - over
      end
    end
  end
  if toMe and kind <= SPELL_DMG then
    fTaken = fTaken + amount
    if hostile then
      trackTarget(srcGUID, srcName, amount)
    end
  elseif toMe and hostile then
    trackTarget(srcGUID, srcName, nil)
  end

  if hostile and not fromPet then
    fLast = ts
  end
end
F.handle = handle

--- The first event proves the client hands out readable combat events (the 12.x engine may register the event
--- but pass secret values, which cannot even be compared).
local function readable(ts, sub, _, srcGUID)
  if ns.isSecret(ts) or ns.isSecret(sub) or ns.isSecret(srcGUID) then
    error("secret combat event")
  end
  return type(ts) == "number" and type(sub) == "string"
end

local verified = false
local registered = false
local delivered = false -- any combat event arrived since registering
local combatSeen = false -- a combat began since registering
local onCombatLogEvent

--- Combat events are withheld on this client: stop listening and let the damage meter take over.
local function restrict()
  if registered then
    registered = false
    ns.off("COMBAT_LOG_EVENT_UNFILTERED", onCombatLogEvent)
  end
  if F.available == false then
    return
  end
  F.available = false
  if open and not encounterActive then
    open = false
    ns.emit("FIGHT_DROPPED")
  end
  ns.emit("SETTINGS")
  ns.refreshPanel()
end
F.restrict = restrict

onCombatLogEvent = function()
  if not verified then
    delivered = true
    local ok, fine = pcall(readable, getEventInfo())
    if not ok or not fine then
      restrict()
      return
    end
    verified = true
    F.available = true
  end
  -- A secret value past the first event would raise an error on every one after it; switch over instead.
  if not pcall(handle, getEventInfo()) then
    restrict()
  end
end
F.onCombatLogEvent = onCombatLogEvent

--- Whether the client hands combat events to addons, asked before registering so the 12.x engine never flags
--- Vigil for a forbidden action. An error, a secret or anything but a plain false counts as restricted.
local function combatLogOpen()
  if not getEventInfo then
    return false
  end
  if type(C_CombatLog) == "table" and type(C_CombatLog.IsCombatLogRestricted) == "function" then
    local ok, restricted = pcall(C_CombatLog.IsCombatLogRestricted)
    if not ok or isSecret(restricted) or restricted ~= false then
      return false
    end
  end
  return true
end
F.combatLogOpen = combatLogOpen

--- "events" (the client's combat events), "meter" (the game's damage meter), "none", or "unknown" before the
--- first combat event.
function F.source()
  if F.available == true then
    return "events"
  elseif F.available == nil then
    return "unknown"
  end
  return ns.meter.available() and "meter" or "none"
end

-- ---------------------------------------------------------------------------
-- Reading the fight (UI, callouts)
-- ---------------------------------------------------------------------------

function F.isOpen()
  return open
end

function F.inCombat()
  return inCombat
end

function F.boss()
  return open and fBoss or nil
end

--- The fight in progress as of now, written into `view` (the caller's table, reused every refresh).
function F.read(view)
  local now = fightNow()
  view.open = open
  view.available = F.available
  view.source = F.source()
  view.inCombat = inCombat
  if not open then
    view.elapsed = combatSince and inCombat and (GetTime() - combatSince) or 0
    return view
  end
  -- While fighting the clock runs; once the enemies stop, it holds at the last exchange like the final report.
  local finish = now
  if not inCombat and not encounterActive then
    finish = fLast
  end
  local elapsed = math.max(0.001, finish - fStart)
  view.elapsed = elapsed
  view.label = fightLabel()
  view.boss = fBoss
  view.encounter = encounterActive
  view.damage = fDamage + fPetDamage
  view.petDamage = fPetDamage
  view.dps = view.damage / math.max(1, elapsed)
  view.healing = fHealing + fPetHealing
  view.hps = view.healing / math.max(1, elapsed)
  view.taken = fTaken
  view.active = math.min(elapsed, fActive)
  view.idleNow = math.max(0, now - cursor)
  view.idle = fIdle + (view.idleNow >= MIN_IDLE and view.idleNow or 0)
  view.lastGapStart = lastGapStart
  view.lastGapLength = lastGapLength
  return view
end

function F.last()
  return history[#history]
end

--- Closes a fight that has gone quiet; the UI calls this a few times a second.
function F.tick()
  -- Without combat events nothing moves fLast; an encounter then lasts until ENCOUNTER_END.
  if open and F.available ~= false and fightNow() - fLast > (encounterActive and BOSS_TIMEOUT or IDLE_GAP) then
    closeFight(nil)
  end
end

-- ---------------------------------------------------------------------------
-- Client events
-- ---------------------------------------------------------------------------

function F.setPlayer(guid)
  if type(guid) == "string" and not ns.isSecret(guid) then
    playerGUID = guid
  end
end

function F.onRegenDisabled()
  inCombat = true
  combatSince = GetTime()
  if registered then
    combatSeen = true
  end
  ns.emit("COMBAT", true)
end

function F.onRegenEnabled()
  inCombat = false
  -- Every combat has events on or by the player; a whole one without any means the client withholds them.
  if F.available == nil and registered and combatSeen and not delivered then
    restrict()
  end
  -- Feign Death drops combat for a moment; the fight goes on.
  if open and not encounterActive and not ns.clean(UnitIsFeignDeath, "player") then
    closeFight(nil)
  end
  ns.emit("COMBAT", false)
end

--- The encounter ID and name may be secret on the 12.x engine; those are dropped, never compared.
function F.onEncounterStart(encounterId, name)
  if isSecret(encounterId) or type(encounterId) ~= "number" then
    encounterId = nil
  end
  if isSecret(name) or type(name) ~= "string" or name == "" then
    name = nil
  end
  local now = fightNow()
  closeFight(nil)
  startFight(now)
  encounterActive = true
  fEncounterId = encounterId
  fEncounterName = type(name) == "string" and name or nil
  fBoss = ns.intel and (ns.intel.forEncounter(encounterId) or ns.intel.forUnit(nil, name)) or nil
  if ns.intel then
    ns.intel.onEncounterStart(encounterId, name)
  end
end

function F.onEncounterEnd()
  if encounterActive then
    local now = fightNow()
    if now > fLast then
      fLast = now
    end
    closeFight(now)
  end
end

F.available = nil

function F.init()
  F.setPlayer(ns.clean(UnitGUID, "player"))
  ns.on("PLAYER_REGEN_DISABLED", F.onRegenDisabled)
  ns.on("PLAYER_REGEN_ENABLED", F.onRegenEnabled)
  ns.on("ENCOUNTER_START", function(_, encounterId, name)
    F.onEncounterStart(encounterId, name)
  end)
  ns.on("ENCOUNTER_END", function()
    F.onEncounterEnd()
  end)
  if not combatLogOpen() then
    F.available = false
    return
  end
  -- A client that refuses the registration without an error says so here, now or a frame later.
  local blocked = false
  ns.on("ADDON_ACTION_FORBIDDEN", function(_, addon)
    if not isSecret(addon) and addon == ns.name and F.available == nil then
      blocked = true
      restrict()
    end
  end)
  registered = ns.on("COMBAT_LOG_EVENT_UNFILTERED", onCombatLogEvent)
  if not registered or blocked then
    restrict()
  end
end
