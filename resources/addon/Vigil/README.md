# Vigil

Personal performance review for the Order of Saint Michael. The addon never reads combat: the guild site analyses `WoWCombatLog.txt`, which the game writes itself. Vigil only turns logging on and records out-of-combat snapshots of your gear, talents and stats.

## Install

The Vigil desktop app installs and updates the addon. To do it by hand, copy this `Vigil` folder into your client's `Interface/AddOns/` directory and restart the client (a `/reload` does not pick up a new TOC).

```text
World of Warcraft/_classic_beta_/Interface/AddOns/Vigil/   <- Forever beta
World of Warcraft/_anniversary_/Interface/AddOns/Vigil/
World of Warcraft/_classic_era_/Interface/AddOns/Vigil/
```

## Use

1. Turn on **Advanced Combat Logging** once, in System > Network.
2. Click the Vigil button on the minimap (or type `/vigil`) to open the panel. Right-click the button to turn combat logging on or off. Drag it to move it around the minimap.
3. By default combat logging turns on when you enter a dungeon or raid and off again when you leave. The panel can instead keep it on at every login. If the client has no `LoggingCombat`, type `/combatlog` instead.
4. Play. Snapshots are taken on login, after each fight, and when gear, level or talents change. Uploads happen from the Vigil desktop app.

## Slash commands

| Command | Action |
| --- | --- |
| `/vigil` | Open or close the panel |
| `/vigil help` | List commands |
| `/vigil log` | Turn combat logging on or off now |
| `/vigil log on`, `/vigil log off` | Combat logging now and on every login |
| `/vigil minimap` | Show or hide the minimap button |
| `/vigil status` | Logging state and snapshot count |
| `/vigil snapshot` | Save a snapshot now (out of combat) |
| `/vigil export` | Copy window with your snapshots |
| `/vigil clear` | Delete saved snapshots |

## SavedVariables

`VigilDB.machineExport` is a JSON string: `{"version":1,"addon":"Vigil","addonVersion":"0.2.0","snapshots":[...]}`. Each snapshot has `at` (Unix seconds), `name`, `realm`, `guid`, `class`, `race`, `level`, `stats`, `gear` and `talents`. The site parses it with `src/lib/vigil/saved-variables.ts`.

## Forever client limits

Forever runs the 12.x engine with Midnight's addon restrictions: no `COMBAT_LOG_EVENT_UNFILTERED`, and many unit values are secret. Vigil reads every API through a guard that drops secret values, and only snapshots outside combat.

Not affiliated with or endorsed by Blizzard Entertainment.
