import type { Boss, Instance } from "../bosses";
import { RAGEFIRE_CHASM } from "./ragefire-chasm";
import { WAILING_CAVERNS } from "./wailing-caverns";
import { DEADMINES } from "./deadmines";
import { SHADOWFANG_KEEP } from "./shadowfang-keep";
import { BLACKFATHOM_DEEPS } from "./blackfathom-deeps";
import { STOCKADE } from "./stockade";
import { GNOMEREGAN } from "./gnomeregan";
import { RAZORFEN_KRAUL } from "./razorfen-kraul";
import { SCARLET_MONASTERY } from "./scarlet-monastery";
import { RAZORFEN_DOWNS } from "./razorfen-downs";
import { ULDAMAN } from "./uldaman";
import { ZULFARRAK } from "./zulfarrak";
import { MARAUDON } from "./maraudon";
import { SUNKEN_TEMPLE } from "./sunken-temple";
import { BLACKROCK_DEPTHS } from "./blackrock-depths";
import { BLACKROCK_SPIRE } from "./blackrock-spire";
import { DIRE_MAUL } from "./dire-maul";
import { SCHOLOMANCE } from "./scholomance";
import { STRATHOLME } from "./stratholme";

/** Classic 5-player dungeons (Upper Blackrock Spire is a 10-player instance), in level order. */
export const DUNGEONS: Instance[] = [
  { id: "rfc", name: "Ragefire Chasm", short: "RFC", kind: "dungeon", mapId: 389, size: 5, levels: [13, 22] },
  { id: "wc", name: "Wailing Caverns", short: "WC", kind: "dungeon", mapId: 43, size: 5, levels: [15, 28] },
  { id: "deadmines", name: "The Deadmines", short: "Deadmines", kind: "dungeon", mapId: 36, size: 5, levels: [15, 28] },
  { id: "sfk", name: "Shadowfang Keep", short: "SFK", kind: "dungeon", mapId: 33, size: 5, levels: [18, 32] },
  { id: "bfd", name: "Blackfathom Deeps", short: "BFD", kind: "dungeon", mapId: 48, size: 5, levels: [20, 34] },
  { id: "stockade", name: "The Stockade", short: "Stockade", kind: "dungeon", mapId: 34, size: 5, levels: [22, 34] },
  { id: "gnomeregan", name: "Gnomeregan", short: "Gnomer", kind: "dungeon", mapId: 90, size: 5, levels: [24, 40] },
  { id: "rfk", name: "Razorfen Kraul", short: "RFK", kind: "dungeon", mapId: 47, size: 5, levels: [24, 40] },
  { id: "sm-graveyard", name: "Scarlet Monastery: Graveyard", short: "SM Graveyard", kind: "dungeon", mapId: 189, size: 5, levels: [29, 48] },
  { id: "sm-library", name: "Scarlet Monastery: Library", short: "SM Library", kind: "dungeon", mapId: 189, size: 5, levels: [29, 48] },
  { id: "sm-armory", name: "Scarlet Monastery: Armory", short: "SM Armory", kind: "dungeon", mapId: 189, size: 5, levels: [29, 48] },
  { id: "sm-cathedral", name: "Scarlet Monastery: Cathedral", short: "SM Cathedral", kind: "dungeon", mapId: 189, size: 5, levels: [29, 48] },
  { id: "rfd", name: "Razorfen Downs", short: "RFD", kind: "dungeon", mapId: 129, size: 5, levels: [33, 47] },
  { id: "uldaman", name: "Uldaman", short: "Uldaman", kind: "dungeon", mapId: 70, size: 5, levels: [38, 53] },
  { id: "zf", name: "Zul'Farrak", short: "ZF", kind: "dungeon", mapId: 209, size: 5, levels: [43, 54] },
  { id: "maraudon", name: "Maraudon", short: "Maraudon", kind: "dungeon", mapId: 349, size: 5, levels: [40, 58] },
  { id: "st", name: "Temple of Atal'Hakkar", short: "Sunken Temple", kind: "dungeon", mapId: 109, size: 5, levels: [44, 60] },
  { id: "brd", name: "Blackrock Depths", short: "BRD", kind: "dungeon", mapId: 230, size: 5, levels: [48, 60] },
  { id: "lbrs", name: "Lower Blackrock Spire", short: "LBRS", kind: "dungeon", mapId: 229, size: 5, levels: [52, 60] },
  { id: "ubrs", name: "Upper Blackrock Spire", short: "UBRS", kind: "dungeon", mapId: 229, size: 10, levels: [56, 60] },
  { id: "dm-east", name: "Dire Maul: East", short: "DM East", kind: "dungeon", mapId: 429, size: 5, levels: [54, 60] },
  { id: "dm-west", name: "Dire Maul: West", short: "DM West", kind: "dungeon", mapId: 429, size: 5, levels: [56, 60] },
  { id: "dm-north", name: "Dire Maul: North", short: "DM North", kind: "dungeon", mapId: 429, size: 5, levels: [56, 60] },
  { id: "scholomance", name: "Scholomance", short: "Scholo", kind: "dungeon", mapId: 289, size: 5, levels: [56, 60] },
  { id: "strat-live", name: "Stratholme: Live", short: "Strat Live", kind: "dungeon", mapId: 329, size: 5, levels: [56, 60] },
  { id: "strat-undead", name: "Stratholme: Undead", short: "Strat Undead", kind: "dungeon", mapId: 329, size: 5, levels: [56, 60] },
];

export const DUNGEON_BOSSES: Boss[] = [
  ...RAGEFIRE_CHASM,
  ...WAILING_CAVERNS,
  ...DEADMINES,
  ...SHADOWFANG_KEEP,
  ...BLACKFATHOM_DEEPS,
  ...STOCKADE,
  ...GNOMEREGAN,
  ...RAZORFEN_KRAUL,
  ...SCARLET_MONASTERY,
  ...RAZORFEN_DOWNS,
  ...ULDAMAN,
  ...ZULFARRAK,
  ...MARAUDON,
  ...SUNKEN_TEMPLE,
  ...BLACKROCK_DEPTHS,
  ...BLACKROCK_SPIRE,
  ...DIRE_MAUL,
  ...SCHOLOMANCE,
  ...STRATHOLME,
];
