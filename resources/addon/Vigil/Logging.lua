local _, ns = ...

local clean, say, now, after = ns.clean, ns.say, ns.now, ns.after
local isSecret = ns.isSecret

--[[
  LoggingCombat is rate limited to 5 calls per 10 seconds, shared by every addon and /combatlog, and the
  limit counts plain queries too. A limited call returns nil and changes nothing. So Vigil never polls it:
  the state lives in `loggingState`, refreshed by the return value of each set, one query at login, and
  occasional guarded queries. The UI only reads the cache.
]]

local LOG_CALL_WINDOW = 10
local LOG_CALL_BUDGET = 3
local LOG_RETRY_DELAY = 2.5
local LOG_MAX_ATTEMPTS = 6
local LOG_QUERY_MIN_INTERVAL = 5

local loggingState -- true, false, or nil while unknown
local lastLogQuery = -math.huge
local logCalls = {}
local pendingLogging -- the state a set is still waiting to apply, or nil
local pendingAttempts = 0
local pendingTimer = false
local pendingDone
local pendingToken = 0
-- True once a change has been pending longer than PENDING_INDICATOR_DELAY; only then does the UI show it.
local pendingIndicator = false
local PENDING_INDICATOR_DELAY = 0.3
-- A short note after a change finally failed (rate limited or refused); cleared by the next request.
local logNote

local L = {}
ns.logging = L

local function loggingAvailable()
  return type(LoggingCombat) == "function"
end
L.available = loggingAvailable

--- Classic clients have returned booleans, 1/nil and 0; nil means the call was rate limited.
local function normalizeLogState(v)
  if v == nil or isSecret(v) then
    return nil
  end
  return v ~= false and v ~= 0
end

local function logBudgetLeft()
  local t = now()
  while logCalls[1] and t - logCalls[1] >= LOG_CALL_WINDOW do
    table.remove(logCalls, 1)
  end
  return LOG_CALL_BUDGET - #logCalls
end

local function logBudgetDelay()
  if not logCalls[1] then
    return 0
  end
  return math.max(0.1, LOG_CALL_WINDOW - (now() - logCalls[1]) + 0.1)
end

--- Reads the client's logging state when the budget allows; otherwise the cached value. The second result
--- is true only when the game itself answered.
local function queryLogging(force)
  if not loggingAvailable() or pendingLogging ~= nil then
    return loggingState, false
  end
  if not force and now() - lastLogQuery < LOG_QUERY_MIN_INTERVAL then
    return loggingState, false
  end
  if logBudgetLeft() < 1 then
    return loggingState, false
  end
  table.insert(logCalls, now())
  lastLogQuery = now()
  -- Zero arguments: passing nil explicitly turns logging off.
  local ok, v = pcall(LoggingCombat)
  local state
  if ok then
    state = normalizeLogState(v)
  end
  if state ~= nil then
    loggingState = state
  end
  return loggingState, state ~= nil
end
L.query = queryLogging

local function isLogging()
  return loggingState == true
end
L.isOn = isLogging

function L.state()
  return loggingState
end

function L.pendingIndicator()
  return pendingIndicator
end

function L.isPending()
  return pendingLogging ~= nil
end

function L.note()
  return logNote
end

local function advancedLoggingOn()
  if type(C_CVar) == "table" then
    return clean(C_CVar.GetCVar, "advancedCombatLogging") == "1"
  end
  return clean(GetCVar, "advancedCombatLogging") == "1"
end
L.advancedOn = advancedLoggingOn

L.ADVANCED_HINT = "turn on Advanced Combat Logging in System > Network for rage, mana and position data."

local flushLogging

local function scheduleLoggingFlush(delay)
  if pendingTimer then
    return
  end
  pendingTimer = true
  if not after(delay, flushLogging) then
    flushLogging()
  end
end

local function finishLogging(success)
  pendingLogging = nil
  pendingAttempts = 0
  pendingToken = pendingToken + 1
  pendingIndicator = false
  local done = pendingDone
  pendingDone = nil
  if done then
    done(success)
  end
end

flushLogging = function()
  pendingTimer = false
  local want = pendingLogging
  if want == nil then
    return
  end
  if logBudgetLeft() < 1 then
    scheduleLoggingFlush(logBudgetDelay())
    return
  end
  table.insert(logCalls, now())
  local ok, v = pcall(LoggingCombat, want)
  local state
  if ok then
    state = normalizeLogState(v)
  end
  if not ok then
    logNote = "The client refused. Type /combatlog in chat instead."
    finishLogging(false)
    say("the client refused to change combat logging. Type /combatlog in chat instead.")
  elseif state ~= nil then
    loggingState = state
    lastLogQuery = now()
    finishLogging(state == want)
  else
    pendingAttempts = pendingAttempts + 1
    if pendingAttempts >= LOG_MAX_ATTEMPTS or type(C_Timer) ~= "table" then
      logNote = "Rate limited by the game. Try again in a few seconds."
      finishLogging(false)
      say("the game is rate limiting combat log changes (5 per 10 seconds, shared with /combatlog). Try again shortly.")
    else
      scheduleLoggingFlush(LOG_RETRY_DELAY)
    end
  end
  ns.refreshPanel()
end

--- Asks for a logging state. The client call runs on the next frame (it can hitch while the log file
--- opens) and retries while the game rate limits it; the UI shows a spinner only if it takes a while.
--- `onDone(success)` follows.
local function requestLogging(on, onDone)
  if not loggingAvailable() then
    say("LoggingCombat is not available on this client. Type /combatlog in chat instead.")
    return false
  end
  on = on and true or false
  if pendingLogging == nil and loggingState == on and not pendingTimer then
    if onDone then
      onDone(true)
    end
    ns.refreshPanel()
    return true
  end
  local wasPending = pendingLogging ~= nil
  pendingLogging = on
  pendingAttempts = 0
  pendingDone = onDone
  logNote = nil
  if not wasPending then
    pendingToken = pendingToken + 1
    local token = pendingToken
    after(PENDING_INDICATOR_DELAY, function()
      if token == pendingToken and pendingLogging ~= nil then
        pendingIndicator = true
        ns.refreshPanel()
      end
    end)
  end
  ns.refreshPanel()
  scheduleLoggingFlush(0)
  return true
end
L.request = requestLogging

function L.statusLine()
  if not loggingAvailable() then
    return "combat log: LoggingCombat unavailable; use /combatlog"
  end
  local settings = ns.ensureDB().settings
  return string.format(
    "combat log: %s, advanced logging: %s, every login: %s, dungeons and raids: %s",
    loggingState == nil and "unknown" or loggingState and "ON" or "off",
    advancedLoggingOn() and "on" or "OFF (System > Network > Advanced Combat Logging)",
    settings.autoLog and "on" or "off",
    settings.autoLogInstances and "on" or "off"
  )
end

--- The confirmed logging state as text and colour; never calls the client.
function L.label()
  local state = loggingState
  if state == nil then
    return "Unknown", 0.6, 0.6, 0.6
  elseif state then
    return "On", 0.3, 1, 0.3
  end
  return "Off", 1, 0.3, 0.3
end

--- In a dungeon or raid: true plus the instance name and type ("party" or "raid").
local function trackedInstance()
  local inInstance, instanceType = clean(IsInInstance)
  if inInstance and (instanceType == "party" or instanceType == "raid") then
    local name = clean(GetInstanceInfo)
    return true, name or clean(GetRealZoneText) or "", instanceType
  end
  return false, clean(GetRealZoneText) or "", instanceType
end
L.trackedInstance = trackedInstance

-- True while logging is on only because the instance option turned it on, so leaving can turn it off.
-- Any manual change (panel, minimap, /vigil log, /combatlog) clears it: the user's choice wins.
local loggingForInstance = false

function L.clearInstanceFlag()
  loggingForInstance = false
end

-- The last dungeon or raid seen ("name|type"), false in the open world, nil before the first check.
local lastInstanceKey
local leaveCheckToken = 0
local LEAVE_CONFIRM_DELAY = 3

local function instanceKey()
  local tracked, name, instanceType = trackedInstance()
  if tracked then
    return name .. "|" .. tostring(instanceType)
  end
  return false
end
L.instanceKey = instanceKey

local instanceRecheck = false

--- Turns logging on for the current dungeon or raid when the option is set and it is not already on.
--- The cached state can be stale (a /combatlog the hook missed, a limited query), so this asks the game,
--- and re-asks once the budget allows rather than trust a cached "on".
local function logForInstance()
  local settings = ns.ensureDB().settings
  if not settings.autoLogInstances or not loggingAvailable() then
    return
  end
  if pendingLogging == true then
    return
  end
  if pendingLogging == nil then
    local state, fresh = queryLogging(true)
    if state == true then
      if not fresh and not instanceRecheck then
        instanceRecheck = true
        after(math.max(LOG_RETRY_DELAY, logBudgetDelay()), function()
          instanceRecheck = false
          if instanceKey() then
            logForInstance()
          end
        end)
      end
      return
    end
  end
  loggingForInstance = true
  requestLogging(true, function(success)
    if success then
      say("combat logging on for this instance.")
      if not advancedLoggingOn() then
        say(L.ADVANCED_HINT)
      end
    else
      loggingForInstance = false
    end
  end)
end
L.logForInstance = logForInstance

local function stopLoggingForInstance()
  if not loggingForInstance or ns.ensureDB().settings.autoLog then
    loggingForInstance = false
    return
  end
  loggingForInstance = false
  requestLogging(false, function(success)
    if success then
      say("combat logging off: you left the instance.")
    end
  end)
end

--- Acts only when the player actually moves into or out of a dungeon or raid, never on other zone events.
--- Leaving is confirmed a few seconds later, since instance info can read stale during a loading screen.
function L.onZoneChanged()
  local key = instanceKey()
  local previous = lastInstanceKey
  if key == previous then
    return
  end
  lastInstanceKey = key
  leaveCheckToken = leaveCheckToken + 1
  if key then
    logForInstance()
  elseif previous then
    local token = leaveCheckToken
    local confirm = function()
      if token == leaveCheckToken and instanceKey() == false then
        stopLoggingForInstance()
      end
    end
    if not after(LEAVE_CONFIRM_DELAY, confirm) then
      confirm()
    end
  end
end

local startupDone = false

--- First PLAYER_ENTERING_WORLD of the session (login or /reload): read the state once, apply 'every login'.
function L.onStartup()
  if startupDone then
    return
  end
  startupDone = true
  if not loggingAvailable() then
    return
  end
  queryLogging(true)
  if ns.ensureDB().settings.autoLog and loggingState ~= true then
    requestLogging(true)
  end
end

--- /combatlog is a manual choice too: stop managing the state and re-read it once the command has run.
function L.hookCombatLogCommand()
  if type(hooksecurefunc) ~= "function" or type(SlashCmdList) ~= "table" then
    return
  end
  if type(SlashCmdList.COMBATLOG) ~= "function" then
    return
  end
  pcall(hooksecurefunc, SlashCmdList, "COMBATLOG", function()
    loggingForInstance = false
    after(1, function()
      queryLogging(true)
      ns.refreshPanel()
    end)
  end)
end

--- Manual toggle from the panel, minimap button, compartment or /vigil log. Clicks while a change is
--- still pending are ignored.
function L.toggle()
  if pendingLogging ~= nil then
    return
  end
  local on = not isLogging()
  loggingForInstance = false
  requestLogging(on, function(success)
    if not success then
      return
    end
    if on then
      say("combat logging on.")
      if not advancedLoggingOn() then
        say(L.ADVANCED_HINT)
      end
    elseif ns.ensureDB().settings.autoLog then
      say("combat logging off. It turns back on at your next login while 'every login' is set.")
    else
      say("combat logging off.")
    end
  end)
end
