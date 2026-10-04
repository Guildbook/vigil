local ADDON_NAME, ns = ...
local ADDON_VERSION = "0.3.4"
ns.version = ADDON_VERSION

local L, S, F, I = ns.logging, ns.snapshots, ns.fight, ns.intel
local say, clean = ns.say, ns.clean

-- ---------------------------------------------------------------------------
-- Slash commands
-- ---------------------------------------------------------------------------

local function line(text)
  DEFAULT_CHAT_FRAME:AddMessage("  " .. text)
end

local function printHelp()
  say("commands:")
  line("/vigil: open or close the settings panel")
  line("/vigil live: show or hide the live fight panel")
  line("/vigil intel: intel for your target, or the last boss")
  line("/vigil intel <name>: look up a boss (\"vancleef\", \"brd emperor\")")
  line("/vigil lock: lock or unlock the live and intel panels")
  line("/vigil fights: your last fights")
  line("/vigil reset: move the panels back to the middle of the screen")
  line("/vigil log: turn combat logging on or off now")
  line("/vigil log on | off: combat logging now, and on every login")
  line("/vigil minimap: show or hide the minimap button")
  line("/vigil status: logging state and snapshot count")
  line("/vigil snapshot: save gear, talents and stats now (out of combat)")
  line("/vigil export: copy window with your snapshots")
  line("/vigil clear: delete saved snapshots")
  DEFAULT_CHAT_FRAME:AddMessage("The Vigil desktop app does the full review and uploads.")
end

local function printStatus()
  local db = ns.ensureDB()
  say(string.format("v%s, %d snapshot(s), %d boss(es) in the intel.", ns.version, #db.snapshots, I.count))
  say(L.statusLine())
  local source = F.source()
  if source == "meter" then
    say("live fight numbers: from the game's damage meter (this client keeps combat events from addons).")
  elseif source == "none" then
    say("live fight tracking: not available on this client (combat events are restricted).")
  end
end

local function printFights()
  local history = F.history
  if #history == 0 then
    say("no fights yet this session.")
    return
  end
  say("last fights:")
  for i = #history, math.max(1, #history - 9), -1 do
    local f = history[i]
    local extra = ""
    if f.healing + f.petHealing > 0 then
      extra = string.format(", %s HPS", ns.formatRate(f.hps))
    end
    line(string.format("%s: %s, %s damage, %s DPS%s, idle %s", f.label, ns.formatTime(f.duration),
      ns.formatNumber(f.damage + f.petDamage), ns.formatRate(f.dps), extra, ns.formatSeconds(f.idle)))
  end
end

local function intelCommand(query)
  if query == "" then
    local boss = I.fromUnit("target") or F.boss() or I.current
    if not boss then
      local last = F.last()
      boss = last and last.boss and I.byKey(last.boss)
    end
    if boss then
      I.lookup(boss)
    else
      say("target a boss, or type /vigil intel <name>.")
    end
    return
  end
  local hits = I.search(query)
  if #hits == 0 then
    say(string.format("no boss matches \"%s\".", query))
    return
  end
  I.lookup(hits[1])
  if #hits > 1 then
    local names = {}
    for i = 2, math.min(#hits, 6) do
      table.insert(names, hits[i].n)
    end
    say(string.format("showing %s. Also matching: %s%s.", hits[1].n, table.concat(names, ", "), #hits > 6 and ", ..." or ""))
  end
end

SLASH_VIGIL1 = "/vigil"
SlashCmdList.VIGIL = function(msg)
  msg = strtrim(msg or "")
  local command, rest = msg:match("^(%S*)%s*(.-)$")
  command = string.lower(command or "")
  local lower = string.lower(msg)
  local db = ns.ensureDB()
  if msg == "" then
    ns.togglePanel()
  elseif command == "help" then
    printHelp()
  elseif command == "live" then
    db.live.shown = not db.live.shown
    ns.emit("SETTINGS")
    ns.refreshPanel()
    say(db.live.shown and "live panel shown." or "live panel hidden. Type /vigil live to show it again.")
  elseif command == "intel" then
    intelCommand(rest or "")
  elseif command == "lock" then
    local locked = not db.live.locked
    db.live.locked, db.intel.locked = locked, locked
    ns.emit("SETTINGS")
    ns.refreshPanel()
    say(locked and "panels locked." or "panels unlocked: drag them to move.")
  elseif command == "fights" then
    printFights()
  elseif command == "reset" then
    ns.livePanel.resetPosition()
    ns.intelPanel.resetPosition()
    say("panels moved back to the middle of the screen.")
  elseif lower == "log" then
    L.toggle()
  elseif lower == "log on" then
    db.settings.autoLog = true
    L.clearInstanceFlag()
    L.request(true, function(success)
      if success then
        say("combat logging on. It turns back on at every login until /vigil log off.")
        if L.ensureAdvanced() == false then
          say(L.ADVANCED_HINT)
        end
      end
    end)
  elseif lower == "log off" then
    db.settings.autoLog = false
    L.clearInstanceFlag()
    L.request(false, function(success)
      if success then
        say("combat logging off.")
      end
    end)
  elseif command == "minimap" then
    ns.setMinimapHidden(not db.minimap.hide)
    if db.minimap.hide then
      say("minimap button hidden. Type /vigil minimap to show it again.")
    else
      say("minimap button shown.")
    end
  elseif command == "status" then
    L.query(false)
    printStatus()
  elseif command == "snapshot" then
    S.take("manual", true)
  elseif command == "export" then
    S.showExport()
  elseif command == "clear" then
    db.snapshots = {}
    ns.refreshMachineExport(db)
    say("snapshots cleared.")
  else
    printHelp()
  end
end

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

local panelsReady = false

ns.on("ADDON_LOADED", function(_, name)
  if name ~= ADDON_NAME then
    return
  end
  ns.refreshMachineExport(ns.ensureDB())
  ns.applyMinimapVisibility()
  if not panelsReady then
    panelsReady = true
    ns.livePanel.init()
    ns.intelPanel.init()
  end
end)

ns.on("PLAYER_LOGIN", function()
  F.setPlayer(clean(UnitGUID, "player"))
  ns.applyMinimapVisibility()
  L.hookCombatLogCommand()
  pcall(ns.registerOptionsCategory)
  S.schedule("login")
end)

local function onZone()
  L.onStartup()
  L.onZoneChanged()
  ns.refreshPanel()
end
ns.on("PLAYER_ENTERING_WORLD", function()
  F.setPlayer(clean(UnitGUID, "player"))
  onZone()
end)
ns.on("ZONE_CHANGED_NEW_AREA", onZone)
ns.on("CVAR_UPDATE", function()
  ns.refreshPanel()
end)
ns.on("PLAYER_REGEN_ENABLED", function()
  L.onCombatEnd()
  S.schedule("combat_end")
  I.scheduleHide()
end)
ns.on("PLAYER_EQUIPMENT_CHANGED", function()
  S.schedule("gear")
end)
ns.on("PLAYER_LEVEL_UP", function()
  S.schedule("level")
end)
ns.on("PLAYER_TALENT_UPDATE", function()
  S.schedule("talents")
end)
ns.on("TRAIT_CONFIG_UPDATED", function()
  S.schedule("talents")
end)
ns.on("PLAYER_TARGET_CHANGED", function()
  I.onTargetChanged()
end)
ns.on("INSTANCE_ENCOUNTER_ENGAGE_UNIT", function()
  I.offer(I.fromUnit("boss1"), "encounter")
end)

F.init()
ns.callouts.init()
