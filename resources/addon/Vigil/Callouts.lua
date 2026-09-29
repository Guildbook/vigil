local _, ns = ...

local clean = ns.clean

--[[
  Quiet callouts in the live panel: text only, never a sound, never an action (Blizzard's addon policy).
  - Idle: no global cooldown used for longer than the threshold while you are in combat with a live enemy
    targeted and not casting. Stays up for a few seconds once you act again, with the gap's length.
  - Dropped buff: a self-buff you had when the fight began (Battle Shout, a paladin seal or aura, Inner Fire, an
    armor spell) has been missing for 3 s. Groups count as one buff, so swapping seals is fine.

  Where the client withholds combat events (F.available == false) there is no global cooldown to time, so the
  idle warning is off. The dropped-buff warning then polls your buffs while in combat, from the pull to leaving
  combat, and goes quiet for the combat as soon as the client hides them (secret auras in 12.x combat).
]]

local C = {}
ns.callouts = C

local BUFF_GRACE = 3
local IDLE_LINGER = 4

-- Spell ID (any rank, for the client's own name) and English name to the group shown in the callout.
local WATCH_SPELLS = {
  { 6673, "Battle Shout", "Battle Shout" },
  { 469, "Commanding Shout", "Commanding Shout" },
  { 21084, "Seal of Righteousness", "Seal" },
  { 21082, "Seal of the Crusader", "Seal" },
  { 20375, "Seal of Command", "Seal" },
  { 20164, "Seal of Justice", "Seal" },
  { 20165, "Seal of Light", "Seal" },
  { 20166, "Seal of Wisdom", "Seal" },
  { 31801, "Seal of Vengeance", "Seal" },
  { 31892, "Seal of Blood", "Seal" },
  { 348700, "Seal of the Martyr", "Seal" },
  { 465, "Devotion Aura", "paladin aura" },
  { 7294, "Retribution Aura", "paladin aura" },
  { 19746, "Concentration Aura", "paladin aura" },
  { 19876, "Shadow Resistance Aura", "paladin aura" },
  { 19888, "Frost Resistance Aura", "paladin aura" },
  { 19891, "Fire Resistance Aura", "paladin aura" },
  { 20218, "Sanctity Aura", "paladin aura" },
  { 25780, "Righteous Fury", "Righteous Fury" },
  { 588, "Inner Fire", "Inner Fire" },
  { 15473, "Shadowform", "Shadowform" },
  { 13165, "Aspect of the Hawk", "Aspect" },
  { 13163, "Aspect of the Monkey", "Aspect" },
  { 34074, "Aspect of the Viper", "Aspect" },
  { 19506, "Trueshot Aura", "Trueshot Aura" },
  { 168, "Frost Armor", "Armor" },
  { 7302, "Ice Armor", "Armor" },
  { 6117, "Mage Armor", "Armor" },
  { 30482, "Molten Armor", "Armor" },
  { 687, "Demon Skin", "Armor" },
  { 706, "Demon Armor", "Armor" },
  { 28176, "Fel Armor", "Armor" },
  { 324, "Lightning Shield", "Shield" },
  { 24398, "Water Shield", "Shield" },
}

local WATCH = {} -- aura name -> group
for _, entry in ipairs(WATCH_SPELLS) do
  WATCH[entry[2]] = entry[3]
  local localName = ns.spellName(entry[1])
  if localName then
    WATCH[localName] = entry[3]
  end
end

local present = {} -- watched aura name -> true while on the player
local groupCount = {} -- group -> auras up
local atPull = {} -- group -> true when up as the fight began
local missingSince = {} -- group -> GetTime() it went missing mid-fight
local aurasHidden = false -- the client hid your buffs this fight: no dropped-buff callout

local function addAura(name)
  local group = WATCH[name]
  if not group or present[name] then
    return
  end
  present[name] = true
  groupCount[group] = (groupCount[group] or 0) + 1
  missingSince[group] = nil
end

local function removeAura(name)
  local group = WATCH[name]
  if not group or not present[name] then
    return
  end
  present[name] = nil
  local left = (groupCount[group] or 1) - 1
  groupCount[group] = left > 0 and left or 0
  if left <= 0 and atPull[group] and not missingSince[group] then
    missingSince[group] = ns.now()
  end
end

local function seenBuff(name)
  addAura(name)
end

--- Reads the player's buffs from the client (fight start, login): combat events only cover changes. False when
--- the client hides them.
local function rescan()
  for name in pairs(present) do
    present[name] = nil
  end
  for group in pairs(groupCount) do
    groupCount[group] = 0
  end
  return ns.eachBuff("player", seenBuff) == true
end
C.rescan = rescan

local function restricted()
  return ns.fight.available == false
end

--- Without combat events: re-reads the buffs (a few times a second, in combat) and times the groups gone since the
--- pull. Only GetTime() arithmetic; aura data is only read when it is not secret.
local function pollAuras()
  if aurasHidden then
    return
  end
  if not rescan() then
    aurasHidden = true
    for group in pairs(missingSince) do
      missingSince[group] = nil
    end
    return
  end
  local now = ns.now()
  for group in pairs(atPull) do
    if (groupCount[group] or 0) > 0 then
      missingSince[group] = nil
    elseif not missingSince[group] then
      missingSince[group] = now
    end
  end
end

--- From the fight tracker: a SPELL_AURA_* event on the player.
function C.onPlayerAura(kind, name)
  if not WATCH[name] then
    return
  end
  local K = ns.fight.KIND
  if kind == K.AURA_ON or kind == K.AURA_REFRESH then
    addAura(name)
  elseif kind == K.AURA_OFF then
    removeAura(name)
  end
end

local function onFightStart()
  aurasHidden = not rescan()
  for group in pairs(atPull) do
    atPull[group] = nil
  end
  for group in pairs(missingSince) do
    missingSince[group] = nil
  end
  for group, count in pairs(groupCount) do
    if count > 0 then
      atPull[group] = true
    end
  end
end

local function onFightEnd()
  for group in pairs(atPull) do
    atPull[group] = nil
  end
  for group in pairs(missingSince) do
    missingSince[group] = nil
  end
end

-- ---------------------------------------------------------------------------
-- The line in the live panel
-- ---------------------------------------------------------------------------

local idleShown = false -- the idle warning is up for the gap in progress
local idleDoneText, idleDoneUntil
local lines = {}

local function hasLiveEnemyTarget()
  if not clean(UnitExists, "target") or clean(UnitIsDead, "target") then
    return false
  end
  return clean(UnitCanAttack, "player", "target") == true
end

local function casting()
  return clean(UnitCastingInfo, "player") ~= nil or clean(UnitChannelInfo, "player") ~= nil
end

--- The callout text for `view` (the fight tracker's read), or nil. Called by the live panel a few times a second.
function C.text(view)
  local db = ns.ensureDB().callouts
  local limited = view.available == false
  if not db.enabled or not (limited and view.inCombat or not limited and view.open) then
    idleShown, idleDoneText = false, nil
    return nil
  end
  for i = #lines, 1, -1 do
    lines[i] = nil
  end
  if limited and db.buffs then
    pollAuras()
  end
  local now = ns.now()

  if db.buffs and not aurasHidden then
    for group, since in pairs(missingSince) do
      if now - since >= BUFF_GRACE then
        table.insert(lines, string.format("No %s for %d s", group, math.floor(now - since)))
      end
    end
  end

  if db.idle and view.available then
    local threshold = db.idleSeconds
    if view.inCombat and view.idleNow >= threshold and hasLiveEnemyTarget() and not casting() then
      idleShown = true
      idleDoneText = nil
      table.insert(lines, string.format("Idle for %.1f s", view.idleNow))
    elseif idleShown and view.idleNow < threshold then
      idleShown = false
      if view.lastGapLength >= threshold then
        idleDoneText = string.format("Idle for %.1f s", view.lastGapLength)
        idleDoneUntil = now + IDLE_LINGER
      end
    end
    if idleDoneText and not idleShown then
      if now < idleDoneUntil then
        table.insert(lines, idleDoneText)
      else
        idleDoneText = nil
      end
    end
  end

  if #lines == 0 then
    return nil
  end
  return table.concat(lines, "\n")
end

--- Whether the idle warning can run on this client (it needs combat events).
function C.idleAvailable()
  return not restricted()
end

function C.init()
  -- With combat events a fight runs from the first hostile exchange; without them, while you are in combat.
  ns.listen("FIGHT_START", function()
    if not restricted() then
      onFightStart()
    end
  end)
  ns.listen("FIGHT_END", onFightEnd)
  ns.listen("FIGHT_DROPPED", function()
    if not restricted() then
      onFightEnd()
    end
  end)
  ns.listen("COMBAT", function(inCombat)
    if not restricted() then
      return
    end
    if inCombat then
      onFightStart()
    else
      onFightEnd()
    end
  end)
  rescan()
end
