# Vigil

Personal performance review for the Order of Saint Michael. The addon never reads combat: the guild site analyses `WoWCombatLog.txt`, which the game writes itself. Vigil only turns logging on and records out-of-combat snapshots of your gear, talents and stats.

## Install

Copy this `Vigil` folder into your client's `Interface/AddOns/` directory, restart the client, then type `/vigil` in chat.

```text
World of Warcraft/_classic_beta_/Interface/AddOns/Vigil/   <- Forever beta
World of Warcraft/_classic_era_/Interface/AddOns/Vigil/
```

## Use

1. Turn on **Advanced Combat Logging** once, in System > Network.
2. `/vigil log on` starts combat logging now and at every login (`/vigil log off` stops it). If the client has no `LoggingCombat`, type `/combatlog` instead.
3. Play. Snapshots are taken on login, after each fight, and when gear, level or talents change.
4. On the guild site, open **Vigil**, pick `Logs/WoWCombatLog.txt` and, optionally, `WTF/Account/<account>/SavedVariables/Vigil.lua` (written on `/reload` or logout).

## Slash commands

| Command | Action |
| --- | --- |
| `/vigil` | Help |
| `/vigil log on`, `/vigil log off` | Combat logging now and on every login |
| `/vigil status` | Logging state and snapshot count |
| `/vigil snapshot` | Save a snapshot now (out of combat) |
| `/vigil export` | Copy window with your snapshots |
| `/vigil clear` | Delete saved snapshots |

## SavedVariables

`VigilDB.machineExport` is a JSON string: `{"version":1,"addon":"Vigil","addonVersion":"0.1.0","snapshots":[...]}`. Each snapshot has `at` (Unix seconds), `name`, `realm`, `guid`, `class`, `race`, `level`, `stats`, `gear` and `talents`. The site parses it with `src/lib/vigil/saved-variables.ts`.

## Forever client limits

Forever runs the 12.x engine with Midnight's addon restrictions: no `COMBAT_LOG_EVENT_UNFILTERED`, and many unit values are secret. Vigil reads every API through a guard that drops secret values, and only snapshots outside combat.

Not affiliated with or endorsed by Blizzard Entertainment.
