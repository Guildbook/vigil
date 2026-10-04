# Vigil

Personal performance review for the Order of Saint Michael. In game, Vigil shows the fight in progress, boss intel and a few quiet callouts. The full review and the uploads happen in the Vigil desktop app, which analyses `WoWCombatLog.txt`; the addon also turns logging on for it and records out-of-combat snapshots of your gear, talents and stats.

## Install

The Vigil desktop app installs and updates the addon. To do it by hand, copy this `Vigil` folder into your client's `Interface/AddOns/` directory and restart the client (a `/reload` does not pick up a new TOC or new files).

```text
World of Warcraft/_classic_beta_/Interface/AddOns/Vigil/   <- Forever beta
World of Warcraft/_anniversary_/Interface/AddOns/Vigil/
World of Warcraft/_classic_era_/Interface/AddOns/Vigil/
```

## Use

1. Turn on **Advanced Combat Logging** once, in System > Network. Only the desktop app uses it (it adds power and position data to the log file); the in-game panels work either way.
2. Click the Vigil button on the minimap (or type `/vigil`) to open the settings. Right-click the button to turn combat logging on or off. Drag it to move it around the minimap.
3. By default combat logging turns on at every login, and Advanced Combat Logging (System > Network) is kept on, after combat if you log in fighting. Either can be switched off in the settings; with 'every login' off, logging turns on when you enter a dungeon or raid and off again when you leave. If the client has no `LoggingCombat`, type `/combatlog` instead.
4. Play. The live panel follows each fight; snapshots are taken on login, after each fight, and when gear, level or talents change. Uploads happen from the Vigil desktop app.

### Live panel

A small panel with the current target or boss (with its portrait), the fight time, your damage and DPS (pets, guardians and totems included), idle time, healing when you heal and damage taken. Between fights it shows the last fight's summary. Drag it to move it, right-click it for settings; the settings can lock it, scale it, or show it only in combat.

Fights follow the desktop app's rules, so the numbers agree with its report: a fight starts at the first hostile exchange, ends after 6 seconds of quiet (a boss encounter at `ENCOUNTER_END`), or as you leave combat, and trash under 2 seconds is dropped. Active time counts the global cooldown (measured from your fastest back-to-back casts, as the desktop does); idle gaps are stretches of 2.5 seconds or more off it. The last 10 fights are kept for the session (`/vigil fights`), the last 5 in SavedVariables.

The Classic clients write the combat log to disk in 48 KB batches, and everything left over when you log out or exit. Raids fill a batch in seconds; solo play and small groups can take minutes, so fights reach the desktop app late. The live panel reads the game's combat events directly and is never behind (on Forever and retail it reads the game's damage meter instead; see below). Turning logging off and on does not write the batch early.

### Boss intel

When you target or fight a known boss (every Classic Era dungeon boss, Molten Core and Onyxia's Lair written up; the other Classic raids recognised), a panel shows the boss's summary and each ability with its icon, name and what to do; hover an ability for what it does. It is collapsible, hides a few seconds after the fight, and can be turned off in the settings. `/vigil intel <name>` looks up any boss ("vancleef", "brd emperor"), and stays until you close it.

Bosses are recognised by the NPC ID in their GUID and, when that is missing or wrong, by name. The data is generated from the desktop app's boss data by `pnpm addon:data` into `Data/Bosses.lua`; do not edit that file by hand.

### Callouts

A line at the bottom of the live panel, never a sound:

- **Idle:** no global cooldown used for 2.5 seconds (adjustable) while you are in combat with a live enemy targeted and not casting; once you act again it shows the gap's length for a few seconds.
- **Dropped buff:** a self-buff you had when the fight began has been missing for 3 seconds: Battle Shout, Commanding Shout, a paladin seal or aura, Righteous Fury, Inner Fire, Shadowform, a hunter aspect or Trueshot Aura, a mage or warlock armor, Lightning or Water Shield. Swapping within a group (one seal for another) does not count.

Vigil only shows information. It never casts, targets or clicks for you.

## Slash commands

| Command | Action |
| --- | --- |
| `/vigil` | Open or close the settings |
| `/vigil help` | List commands |
| `/vigil live` | Show or hide the live panel |
| `/vigil intel` | Intel for your target, or the last boss |
| `/vigil intel <name>` | Look up a boss |
| `/vigil lock` | Lock or unlock the live and intel panels |
| `/vigil fights` | Your last fights this session |
| `/vigil reset` | Move the panels back to the middle of the screen |
| `/vigil log` | Turn combat logging on or off now |
| `/vigil log on`, `/vigil log off` | Combat logging now and on every login |
| `/vigil minimap` | Show or hide the minimap button |
| `/vigil status` | Logging state and snapshot count |
| `/vigil snapshot` | Save a snapshot now (out of combat) |
| `/vigil export` | Copy window with your snapshots |
| `/vigil clear` | Delete saved snapshots |

## SavedVariables

`VigilDB.machineExport` is a JSON string: `{"version":1,"addon":"Vigil","addonVersion":"0.3.4","snapshots":[...]}`. Each snapshot has `at` (Unix seconds), `name`, `realm`, `guid`, `class`, `race`, `level`, `stats`, `gear` and `talents`. The site parses it with `src/lib/vigil/saved-variables.ts`.

`VigilDB` version 2 (0.3.0) adds `live`, `intel` and `callouts` settings and `fights`, the last 5 fight summaries (label, boss, duration, damage, DPS, healing, active and idle time). Version 1 data from 0.2.x is kept as it is.

## Files

`Core.lua` (shared helpers, client API guards, SavedVariables, events), `Data/Bosses.lua` (generated), `Logging.lua`, `Snapshots.lua`, `Intel.lua`, `Meter.lua` (the game's damage meter, for 12.x clients), `Fight.lua` (the live tracker), `Callouts.lua`, `Widgets.lua`, `Minimap.lua`, `Settings.lua`, `LivePanel.lua`, `IntelPanel.lua` and `Vigil.lua` (events and slash commands). They share the addon's private table; the only globals are `VigilDB`, the slash command and the addon compartment callbacks. `test/addon-lua.test.ts` runs them in a Lua VM against a mocked client (Classic Era, TBC Anniversary, retail and Forever) and replays a TBC Anniversary log to check the numbers against the desktop engine.

## Forever and retail limits

The 12.x engine (retail Midnight, and the Forever client) keeps combat events from addons and hands out "secret" values: enemy GUIDs and names, your buffs in combat, and the damage meter's numbers in combat. A secret can be shown but not compared, added up or searched.

- **Live panel:** Vigil only registers for combat events when the client offers them (`CombatLogGetCurrentEventInfo` exists and `C_CombatLog.IsCombatLogRestricted()` is false), so it never trips a blocked-action warning. Otherwise, or when a whole combat passes without one, it shows your damage, DPS, healing and HPS for the current session from the game's own damage meter (`C_DamageMeter`). If the meter is switched off in the game's options, the panel says so. Fight history (`/vigil fights`) and saved fight summaries need combat events, so they stay empty there; the desktop app has the full numbers.
- **Callouts:** the idle warning needs combat events and is off. The dropped-buff warning polls your buffs in combat and goes quiet whenever the game hides them.
- **Boss intel:** a target is recognised by name when its GUID is secret; when both are secret, the boss comes from `ENCOUNTER_START`, and `/vigil intel <name>` always works.

Not affiliated with or endorsed by Blizzard Entertainment.
