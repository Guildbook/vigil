import { DUNGEON_BOSSES, DUNGEONS } from "./dungeons";

/**
 * Boss intel for WoW: Forever (Classic Era content): the raids here, the 5-player dungeons in ./dungeons/.
 *
 * Sources, and how sure each field is:
 * - `encounterId`: the ID in ENCOUNTER_START / ENCOUNTER_END, from Blizzard's Classic Era client table
 *   DungeonEncounter (build 1.15.9). Verified for every boss, raids and dungeons. Classic Era only fires the
 *   events in raids, so dungeon bosses are recognised by NPC ID or name; the IDs are kept for when they do fire.
 * - `displayId`: the creature display used for the portrait. Raids: the retail Encounter Journal
 *   (JournalEncounterCreature), which still covers these raids. Verified for Molten Core, Onyxia, Blackwing Lair
 *   and Ahn'Qiraj. Naxxramas uses the Wrath of the Lich King version's models; Zul'Gurub has none (the journal only
 *   knows the Cataclysm remake). Dungeons: the NPC's model in the CMaNGOS Classic database, checked against the
 *   client's CreatureDisplayInfo table and Blizzard's render CDN (null where the CDN has no render).
 * - `npcIds`: the NPC ID in creature GUIDs. Not in any client table we can read. Raids: reference knowledge.
 *   Dungeons: the CMaNGOS Classic database, where the NPC spawns (or is summoned) in that instance. Either way
 *   `npcIdsVerified: false` marks them, and names are matched too, so a wrong ID never hides a boss.
 * - Ability `spellIds`: Classic Era spell IDs, checked against the client's SpellName table (the generated
 *   src/data/boss-spells.json holds the client name for each, and a test compares them). For dungeons, the spells
 *   each boss casts come from the CMaNGOS Classic creature scripts. Descriptions and advice are our own words.
 *   `uncertain` flags details we could not confirm.
 */

export type InstanceId = string;

export type AbilityTag =
  | "tank"
  | "healer"
  | "melee"
  | "ranged"
  | "raid"
  | "dispel"
  | "decurse"
  | "interrupt"
  | "move"
  | "fear"
  | "knockback"
  | "adds";

export interface BossAbility {
  key: string;
  name: string;
  /** Spell IDs as logged; the first names the icon. */
  spellIds: number[];
  /** Other names the ability is logged under (Onyxia's Deep Breath is a family of spells named "Breath"). */
  logNames?: string[];
  /** A render CDN icon name, for spells whose client icon is a placeholder. */
  icon?: string;
  /** The add that uses it, when it is not the boss. */
  source?: string;
  tags: AbilityTag[];
  summary: string;
  counter: string;
  uncertain?: string;
}

export interface Boss {
  key: string;
  name: string;
  instance: InstanceId;
  /** Null for rare elites and other fights without a DungeonEncounter row; they are recognised by unit only. */
  encounterId: number | null;
  /** A rare elite that only sometimes spawns (e.g. Bruegal Ironknuckle in the Stockade). */
  rare?: boolean;
  /** Other DungeonEncounter IDs for the same fight (Blackfathom Deeps has two sets for its 5-player version). */
  altEncounterIds?: number[];
  npcIds: number[];
  /** Adds that belong to the fight (their damage counts toward the encounter's observed abilities). */
  addNpcIds?: number[];
  npcIdsVerified: boolean;
  /** Unit names that identify the boss when a log has no ENCOUNTER_START. */
  unitNames: string[];
  displayId: number | null;
  summary: string;
  abilities: BossAbility[];
  /**
   * "full" covers every scripted ability worth knowing (raid bosses have at least three; a small dungeon kit like
   * Hamhock's can be complete with two, and a melee-only rare with none); "partial" (dungeons) recognises the fight
   * and lists one or two key abilities with more left to write; "scaffold" only identifies the encounter so far.
   */
  status: "full" | "partial" | "scaffold";
  /** Something about the boss itself we could not confirm (shown as Unconfirmed). */
  uncertain?: string;
}

export interface Instance {
  id: InstanceId;
  name: string;
  short: string;
  kind: "raid" | "dungeon";
  /** Instance map ID (DungeonEncounter.MapID). Wings of one dungeon share it. */
  mapId: number;
  size: 5 | 10 | 20 | 40;
  /** Suggested levels, from the client's LFGDungeons table (dungeons only). */
  levels?: [min: number, max: number];
}

export const RAIDS: Instance[] = [
  { id: "mc", name: "Molten Core", short: "MC", kind: "raid", mapId: 409, size: 40 },
  { id: "onyxia", name: "Onyxia's Lair", short: "Onyxia", kind: "raid", mapId: 249, size: 40 },
  { id: "bwl", name: "Blackwing Lair", short: "BWL", kind: "raid", mapId: 469, size: 40 },
  { id: "zg", name: "Zul'Gurub", short: "ZG", kind: "raid", mapId: 309, size: 20 },
  { id: "aq20", name: "Ruins of Ahn'Qiraj", short: "AQ20", kind: "raid", mapId: 509, size: 20 },
  { id: "aq40", name: "Temple of Ahn'Qiraj", short: "AQ40", kind: "raid", mapId: 531, size: 40 },
  { id: "naxx", name: "Naxxramas", short: "Naxx", kind: "raid", mapId: 533, size: 40 },
];

export { DUNGEONS };
export const INSTANCES: Instance[] = [...DUNGEONS, ...RAIDS];

const MOLTEN_CORE: Boss[] = [
  {
    key: "lucifron",
    name: "Lucifron",
    instance: "mc",
    encounterId: 663,
    npcIds: [12118],
    addNpcIds: [12119],
    npcIdsVerified: false,
    unitNames: ["Lucifron"],
    displayId: 13031,
    summary: "A caster with two Flamewaker Protectors. Most of the fight is dispelling and decursing while the guards die first.",
    status: "full",
    abilities: [
      {
        key: "impending-doom",
        name: "Impending Doom",
        spellIds: [19702],
        tags: ["dispel", "healer", "raid"],
        summary: "Magic debuff on players near him that deals heavy Shadow damage when it expires.",
        counter: "Priests and Paladins dispel it before it runs out.",
      },
      {
        key: "lucifrons-curse",
        name: "Lucifron's Curse",
        spellIds: [19703],
        tags: ["decurse", "raid"],
        summary: "Curse on nearby players that sharply raises the cost of every spell and ability.",
        counter: "Mages and Druids remove it, casters and tanks first.",
      },
      {
        key: "dominate-mind",
        name: "Dominate Mind",
        spellIds: [20604],
        source: "Flamewaker Protector",
        tags: ["adds", "raid"],
        summary: "A Protector takes control of a player for a short time.",
        counter: "Crowd-control the controlled player (Polymorph, Fear) rather than killing them; kill the Protectors first.",
      },
      {
        key: "protector-cleave",
        name: "Cleave",
        spellIds: [20605],
        source: "Flamewaker Protector",
        tags: ["melee", "adds"],
        summary: "Frontal cleave from the Protectors.",
        counter: "Only the tank stands in front of a Protector.",
      },
    ],
  },
  {
    key: "magmadar",
    name: "Magmadar",
    instance: "mc",
    encounterId: 664,
    npcIds: [11982],
    npcIdsVerified: false,
    unitNames: ["Magmadar"],
    displayId: 10193,
    summary: "A core hound that fears the raid and enrages. Hunters handle the enrage, everyone watches the floor.",
    status: "full",
    abilities: [
      {
        key: "frenzy",
        name: "Frenzy",
        spellIds: [19451],
        tags: ["tank", "ranged"],
        summary: "Enrage that makes his attacks much faster and hit harder.",
        counter: "Hunters remove it with Tranquilizing Shot right away; set up a rotation.",
      },
      {
        key: "panic",
        name: "Panic",
        spellIds: [19408],
        tags: ["fear", "raid", "tank"],
        summary: "Fears everyone nearby, about every 30 seconds.",
        counter: "Fear Ward on the tank, Tremor Totem, and a Berserker Rage or stance dance from warriors.",
      },
      {
        key: "lava-bomb",
        name: "Lava Bomb",
        spellIds: [19411, 20474],
        tags: ["move", "raid"],
        summary: "Leaves a patch of fire under a player that burns anyone standing in it.",
        counter: "Step out of the fire at once.",
      },
      {
        key: "magma-spit",
        name: "Magma Spit",
        spellIds: [19450, 19449],
        tags: ["tank", "melee", "healer"],
        summary: "Fire damage over time on players in melee range.",
        counter: "Fire resistance on the tank; healers keep melee topped up.",
        uncertain: "Exact trigger (every melee hit, or a periodic splash) not confirmed.",
      },
    ],
  },
  {
    key: "gehennas",
    name: "Gehennas",
    instance: "mc",
    encounterId: 665,
    npcIds: [12259],
    addNpcIds: [11661],
    npcIdsVerified: false,
    unitNames: ["Gehennas"],
    displayId: 13030,
    summary: "Lucifron's twin in layout, with two Flamewakers. His curse cripples healing, so decursers matter most.",
    status: "full",
    abilities: [
      {
        key: "gehennas-curse",
        name: "Gehennas' Curse",
        spellIds: [19716],
        tags: ["decurse", "healer", "tank"],
        summary: "Curse that cuts healing received by three quarters.",
        counter: "Decurse the tank immediately, then everyone else.",
      },
      {
        key: "rain-of-fire",
        name: "Rain of Fire",
        spellIds: [19717],
        tags: ["move", "raid"],
        summary: "Fire rains on an area for several seconds.",
        counter: "Move out of it; spread a little so one cast catches few people.",
      },
      {
        key: "shadow-bolt",
        name: "Shadow Bolt",
        spellIds: [19728, 19729],
        tags: ["raid"],
        summary: "Shadow bolts at random players.",
        counter: "Healers watch for spikes on cloth wearers.",
        uncertain: "Which of the two IDs he uses (single target or random target) not confirmed.",
      },
    ],
  },
  {
    key: "garr",
    name: "Garr",
    instance: "mc",
    encounterId: 666,
    npcIds: [12057],
    addNpcIds: [12099],
    npcIdsVerified: false,
    unitNames: ["Garr"],
    displayId: 12110,
    summary: "A fire elemental lord with eight Firesworn. Adds are banished or tanked apart and killed away from the raid.",
    status: "full",
    abilities: [
      {
        key: "antimagic-pulse",
        name: "Antimagic Pulse",
        spellIds: [19492],
        tags: ["raid"],
        summary: "Periodically strips a beneficial magic effect from players near him.",
        counter: "Reapply important buffs and shields; keep the raid out of range where possible.",
      },
      {
        key: "magma-shackles",
        name: "Magma Shackles",
        spellIds: [19496],
        tags: ["melee", "raid"],
        summary: "Slows the movement of everyone nearby.",
        counter: "Plan positions before the pull; it matters most when moving adds.",
      },
      {
        key: "eruption",
        name: "Eruption",
        spellIds: [19497],
        source: "Firesworn",
        tags: ["melee", "adds", "move"],
        summary: "A Firesworn explodes when it dies, burning everyone around it.",
        counter: "Melee step away as a Firesworn is about to die; kill them one at a time.",
      },
      {
        key: "separation-anxiety",
        name: "Separation Anxiety",
        spellIds: [23492],
        source: "Firesworn",
        tags: ["tank", "adds"],
        summary: "Firesworn dragged too far from Garr grow much stronger.",
        counter: "Off-tank adds within range of Garr.",
        uncertain: "Exact range and effect size not confirmed.",
      },
      {
        key: "firesworn-immolate",
        name: "Immolate",
        spellIds: [20294],
        source: "Firesworn",
        tags: ["healer", "adds"],
        summary: "Fire damage plus a burn over time on add tanks.",
        counter: "Healers keep add tanks' health high.",
        uncertain: "Spell ID shared with other Molten Core casters; attributed to Firesworn from reference knowledge.",
      },
    ],
  },
  {
    key: "shazzrah",
    name: "Shazzrah",
    instance: "mc",
    encounterId: 667,
    npcIds: [12264],
    npcIdsVerified: false,
    unitNames: ["Shazzrah"],
    displayId: 13032,
    summary: "An arcane caster who blinks around the room and explodes. Quick kill, lots of decursing.",
    status: "full",
    abilities: [
      {
        key: "arcane-explosion",
        name: "Arcane Explosion",
        spellIds: [19712],
        tags: ["melee", "raid", "healer"],
        summary: "Frequent Arcane blast around him.",
        counter: "Ranged stay at range; healers keep melee topped up.",
      },
      {
        key: "shazzrahs-curse",
        name: "Shazzrah's Curse",
        spellIds: [19713],
        tags: ["decurse", "raid"],
        summary: "Curse that makes players take more magic damage.",
        counter: "Decurse, starting with melee who eat the explosions.",
      },
      {
        key: "deaden-magic",
        name: "Deaden Magic",
        spellIds: [19714],
        tags: ["dispel", "ranged"],
        summary: "Buff that halves the magic damage he takes.",
        counter: "Purge or Dispel it off him (Shamans and Priests).",
      },
      {
        key: "counterspell",
        name: "Counterspell",
        spellIds: [19715],
        tags: ["raid", "healer"],
        summary: "Interrupts spellcasting of players nearby and locks that school.",
        counter: "Healers stagger casts and avoid starting long heals when he is due to cast it.",
      },
      {
        key: "gate-of-shazzrah",
        name: "Gate of Shazzrah",
        spellIds: [23138],
        tags: ["tank", "raid"],
        summary: "Teleports to a random player, followed by an Arcane Explosion there.",
        counter: "Tanks pick him up fast after each teleport.",
        uncertain: "Whether the teleport also clears threat is not confirmed.",
      },
    ],
  },
  {
    key: "baron-geddon",
    name: "Baron Geddon",
    instance: "mc",
    encounterId: 668,
    npcIds: [12056],
    npcIdsVerified: false,
    unitNames: ["Baron Geddon"],
    displayId: 12129,
    summary: "A fire lord whose Living Bomb kills groups when the target stays in the raid.",
    status: "full",
    abilities: [
      {
        key: "living-bomb",
        name: "Living Bomb",
        spellIds: [20475, 20476],
        logNames: ["Explosion"],
        tags: ["move", "raid"],
        summary: "Marks a player who explodes a few seconds later, hitting everyone near them.",
        counter: "The bomb target runs away from the raid at once; healers top them up.",
      },
      {
        key: "ignite-mana",
        name: "Ignite Mana",
        spellIds: [19659],
        tags: ["dispel", "healer"],
        summary: "Burns mana from nearby players and damages them for what burns.",
        counter: "Dispel it from healers and casters.",
      },
      {
        key: "inferno",
        name: "Inferno",
        spellIds: [19695],
        tags: ["melee", "move"],
        summary: "He roots himself and pulses fire around him.",
        counter: "Melee and the tank back away until it ends.",
      },
      {
        key: "armageddon",
        name: "Armageddon",
        spellIds: [20478],
        tags: ["melee", "raid"],
        summary: "A last explosion at very low health.",
        counter: "Finish him quickly and keep health high near the end.",
        uncertain: "Damage and range at the end of the fight not confirmed.",
      },
    ],
  },
  {
    key: "sulfuron",
    name: "Sulfuron Harbinger",
    instance: "mc",
    encounterId: 669,
    npcIds: [12098],
    addNpcIds: [11662],
    npcIdsVerified: false,
    unitNames: ["Sulfuron Harbinger"],
    displayId: 13030,
    summary: "Four Flamewaker Priests heal him and each other. Kill the priests first, then Sulfuron.",
    status: "full",
    abilities: [
      {
        key: "dark-mending",
        name: "Dark Mending",
        spellIds: [19775],
        source: "Flamewaker Priest",
        tags: ["interrupt", "adds"],
        summary: "A priest heals an ally for a large amount.",
        counter: "Interrupt every cast (Kick, Pummel, Earth Shock).",
      },
      {
        key: "hand-of-ragnaros",
        name: "Hand of Ragnaros",
        spellIds: [19780],
        tags: ["melee", "knockback", "tank"],
        summary: "Fire damage around him that knocks back and stuns.",
        counter: "Melee expect the stun; keep a second tank close.",
      },
      {
        key: "inspire",
        name: "Inspire",
        spellIds: [19779],
        tags: ["tank", "adds"],
        summary: "Makes an ally hit harder and attack faster.",
        counter: "Healers watch add tanks when it lands.",
      },
      {
        key: "flame-spear",
        name: "Flame Spear",
        spellIds: [19781],
        tags: ["ranged", "raid"],
        summary: "Fire spear at a player that splashes those around them.",
        counter: "Ranged spread out.",
      },
      {
        key: "priest-shadow-word-pain",
        name: "Shadow Word: Pain",
        spellIds: [19776],
        source: "Flamewaker Priest",
        tags: ["dispel", "adds"],
        summary: "Shadow damage over time from the priests.",
        counter: "Dispel it when there is time.",
      },
    ],
  },
  {
    key: "golemagg",
    name: "Golemagg the Incinerator",
    instance: "mc",
    encounterId: 670,
    npcIds: [11988],
    addNpcIds: [11672],
    npcIdsVerified: false,
    unitNames: ["Golemagg the Incinerator"],
    displayId: 11986,
    summary: "A giant with two Core Ragers that cannot die while he lives. Tank the dogs away and burn Golemagg.",
    status: "full",
    abilities: [
      {
        key: "magma-splash",
        name: "Magma Splash",
        spellIds: [13880],
        tags: ["tank", "healer"],
        summary: "Stacking fire damage over time on his tank.",
        counter: "Tanks swap when stacks get high; healers focus the main tank.",
        uncertain: "Whether it also lowers armor is not confirmed.",
      },
      {
        key: "pyroblast",
        name: "Pyroblast",
        spellIds: [20228],
        tags: ["raid", "healer"],
        summary: "Big fire hit plus a burn on a random player.",
        counter: "Healers react to the spike.",
      },
      {
        key: "earthquake",
        name: "Earthquake",
        spellIds: [19798],
        tags: ["melee"],
        summary: "Late in the fight, pulses damage to everyone in melee range.",
        counter: "Melee leave when he is almost dead; ranged finish him.",
      },
      {
        key: "golemaggs-trust",
        name: "Golemagg's Trust",
        spellIds: [20553],
        tags: ["tank", "adds"],
        summary: "Core Ragers near Golemagg hit much harder.",
        counter: "Tank the Core Ragers well away from him.",
      },
      {
        key: "mangle",
        name: "Mangle",
        spellIds: [19820],
        source: "Core Rager",
        tags: ["tank", "adds"],
        summary: "Damage over time and a slow on the dog tanks.",
        counter: "Healers keep the Rager tanks up; ignore the dogs for damage.",
      },
    ],
  },
  {
    key: "majordomo",
    name: "Majordomo Executus",
    instance: "mc",
    encounterId: 671,
    npcIds: [12018],
    addNpcIds: [11663, 11664],
    npcIdsVerified: false,
    unitNames: ["Majordomo Executus"],
    displayId: 12029,
    summary: "Win by defeating his eight Flamewaker guards; he submits and summons Ragnaros. Watch the shields.",
    status: "full",
    abilities: [
      {
        key: "magic-reflection",
        name: "Magic Reflection",
        spellIds: [20619],
        tags: ["ranged", "healer"],
        summary: "His guards reflect harmful spells for a few seconds.",
        counter: "Casters stop casting on the guards until it fades.",
      },
      {
        key: "damage-shield",
        name: "Damage Shield",
        spellIds: [21075],
        tags: ["melee"],
        summary: "Melee attacking his guards take Arcane damage back.",
        counter: "Melee stop attacking until it fades.",
      },
      {
        key: "teleport",
        name: "Teleport",
        spellIds: [20618, 20534],
        tags: ["tank", "move"],
        summary: "Sends a player (often a tank) into the burning coals.",
        counter: "Get out of the fire and back to your add.",
      },
      {
        key: "aegis-of-ragnaros",
        name: "Aegis of Ragnaros",
        spellIds: [20620],
        tags: ["adds"],
        summary: "A Shadow shield that absorbs damage and burns melee attackers.",
        counter: "Switch targets or wait for it to break.",
        uncertain: "Which units cast it (guards or Majordomo) not confirmed.",
      },
      {
        key: "healer-shadow-shock",
        name: "Shadow Shock",
        spellIds: [20603],
        source: "Flamewaker Healer",
        tags: ["raid", "adds"],
        summary: "Shadow damage to players near a healer guard.",
        counter: "Kill the Flamewaker Healers first.",
      },
      {
        key: "elite-blast-wave",
        name: "Blast Wave",
        spellIds: [20229],
        source: "Flamewaker Elite",
        tags: ["melee", "adds"],
        summary: "Fire burst around an elite guard that slows.",
        counter: "Tank elites apart from the healers.",
      },
      {
        key: "elite-fire-blast",
        name: "Fire Blast",
        spellIds: [20623],
        source: "Flamewaker Elite",
        tags: ["tank", "adds"],
        summary: "Instant fire hit on the elite's target.",
        counter: "Healers keep elite tanks topped up.",
      },
    ],
  },
  {
    key: "ragnaros",
    name: "Ragnaros",
    instance: "mc",
    encounterId: 672,
    npcIds: [11502],
    addNpcIds: [12143],
    npcIdsVerified: true,
    unitNames: ["Ragnaros"],
    displayId: 11121,
    summary: "The Firelord. Keep melee in range, stay out of his knockback and be ready for the Sons of Flame.",
    status: "full",
    abilities: [
      {
        key: "wrath-of-ragnaros",
        name: "Wrath of Ragnaros",
        spellIds: [20566],
        tags: ["melee", "knockback", "tank"],
        summary: "Fire blast around him that knocks everyone in melee range back.",
        counter: "Melee back off before it; the second tank takes over while the first returns.",
      },
      {
        key: "elemental-fire",
        name: "Elemental Fire",
        spellIds: [20564, 20563],
        tags: ["tank", "healer"],
        summary: "Fire damage over time on his target.",
        counter: "Fire resistance on the tank; healers keep up.",
      },
      {
        key: "magma-blast",
        name: "Magma Blast",
        spellIds: [20565],
        tags: ["tank", "raid"],
        summary: "When nobody is in melee range, he blasts a random player with heavy fire damage.",
        counter: "Always keep someone in melee range.",
      },
      {
        key: "lava-burst",
        name: "Lava Burst",
        spellIds: [21158],
        tags: ["move", "raid"],
        summary: "Lava eruptions that hit and throw players standing near them.",
        counter: "Spread out and stay off the eruptions.",
      },
      {
        key: "melt-weapon",
        name: "Melt Weapon",
        spellIds: [21388, 21387],
        tags: ["melee", "tank"],
        summary: "Hitting him wears down weapon durability.",
        counter: "Repair before the pull.",
      },
      {
        key: "sons-of-flame",
        name: "Summon Sons of Flame",
        spellIds: [21108, 21107],
        logNames: ["Ragnaros Submerge Fade"],
        tags: ["adds", "raid"],
        summary: "He submerges and eight Sons of Flame rise; he returns after they die or a timer runs out.",
        counter: "Everyone kills the Sons; crowd-control what you can.",
        uncertain: "Submerge timing (about 3 minutes in, lasting about 90 seconds) from reference knowledge.",
      },
    ],
  },
];

const ONYXIA: Boss[] = [
  {
    key: "onyxia",
    name: "Onyxia",
    instance: "onyxia",
    encounterId: 1084,
    npcIds: [10184],
    addNpcIds: [11262, 12129],
    npcIdsVerified: false,
    unitNames: ["Onyxia"],
    displayId: 8570,
    summary:
      "Three phases: ground (tank her sideways), air (whelps, fireballs and Deep Breath) from 65%, then ground again with fear and lava from 40%.",
    status: "full",
    abilities: [
      {
        key: "flame-breath",
        name: "Flame Breath",
        spellIds: [18435],
        tags: ["tank", "move"],
        summary: "Fire cone in front of her.",
        counter: "Only the tank faces her head.",
      },
      {
        key: "cleave",
        name: "Cleave",
        spellIds: [19983],
        tags: ["tank", "melee"],
        summary: "Hits her target and those beside them.",
        counter: "Melee stand on her sides.",
      },
      {
        key: "tail-sweep",
        name: "Tail Sweep",
        spellIds: [15847],
        tags: ["melee", "knockback", "move"],
        summary: "Hits and knocks back everyone behind her.",
        counter: "Never stand behind her.",
      },
      {
        key: "wing-buffet",
        name: "Wing Buffet",
        spellIds: [18500],
        tags: ["tank", "knockback"],
        summary: "Frontal hit that knocks players back.",
        counter: "Tank with a wall behind you.",
      },
      {
        key: "knock-away",
        name: "Knock Away",
        spellIds: [19633],
        tags: ["tank", "knockback"],
        summary: "Knocks the tank back.",
        counter: "Get back in position quickly.",
        uncertain: "Whether it also reduces threat in Classic Era is not confirmed.",
      },
      {
        key: "fireball",
        name: "Fireball",
        spellIds: [18392],
        tags: ["ranged", "healer", "move"],
        summary: "In the air phase, fireballs at random players that splash those nearby.",
        counter: "Spread out.",
      },
      {
        key: "deep-breath",
        name: "Deep Breath",
        spellIds: [17086, 18351, 18564, 18576, 18584, 18596, 18609, 18617],
        logNames: ["Breath", "Deep Breath"],
        tags: ["raid", "move"],
        summary: "She flies to one side and breathes fire across the room; it kills most players it hits.",
        counter: "When she inhales, move out of her path to the sides of the room.",
        uncertain: "The damage is logged under several spell IDs named Breath; any of them counts.",
      },
      {
        key: "onyxian-whelps",
        name: "Summon Onyxia Whelp",
        spellIds: [17646],
        icon: "inv_misc_head_dragon_black",
        tags: ["adds", "tank"],
        summary: "Whelps pour out of the side caves during the air phase.",
        counter: "Area damage and off-tanks pick them up before they reach healers.",
      },
      {
        key: "bellowing-roar",
        name: "Bellowing Roar",
        spellIds: [18431],
        tags: ["fear", "raid"],
        summary: "Phase three fear that hits the whole room.",
        counter: "Fear Ward, Tremor Totem and stance dance; stay off the cracks when it lands.",
      },
      {
        key: "eruption",
        name: "Eruption",
        spellIds: [17731],
        tags: ["move", "raid"],
        summary: "Lava bursts from floor cracks in phase three, often right after a fear.",
        counter: "Stand away from the cracks before the fear.",
      },
    ],
  },
];

type Scaffold = [key: string, name: string, encounterId: number, displayId: number | null, extraNames?: string[]];

function scaffold(instance: InstanceId, rows: Scaffold[]): Boss[] {
  return rows.map(([key, name, encounterId, displayId, extraNames]) => ({
    key,
    name,
    instance,
    encounterId,
    npcIds: [],
    npcIdsVerified: false,
    unitNames: [name, ...(extraNames ?? [])],
    displayId,
    summary: "Encounter recognised; abilities are not written up yet.",
    abilities: [],
    status: "scaffold" as const,
  }));
}

const BLACKWING_LAIR = scaffold("bwl", [
  ["razorgore", "Razorgore the Untamed", 610, 10115],
  ["vaelastrasz", "Vaelastrasz the Corrupt", 611, 13992],
  ["broodlord", "Broodlord Lashlayer", 612, 14308],
  ["firemaw", "Firemaw", 613, 6377],
  ["ebonroc", "Ebonroc", 614, 6377],
  ["flamegor", "Flamegor", 615, 6377],
  ["chromaggus", "Chromaggus", 616, 14367],
  ["nefarian", "Nefarian", 617, 11380, ["Lord Victor Nefarius"]],
]);

const ZUL_GURUB = scaffold("zg", [
  ["jeklik", "High Priestess Jeklik", 785, null],
  ["venoxis", "High Priest Venoxis", 784, null],
  ["marli", "High Priestess Mar'li", 786, null],
  ["mandokir", "Bloodlord Mandokir", 787, null],
  ["edge-of-madness", "Edge of Madness", 788, null, ["Gri'lek", "Hazza'rah", "Renataki", "Wushoolay"]],
  ["thekal", "High Priest Thekal", 789, null],
  ["gahzranka", "Gahz'ranka", 790, null],
  ["arlokk", "High Priestess Arlokk", 791, null],
  ["jindo", "Jin'do the Hexxer", 792, null],
  ["hakkar", "Hakkar", 793, null],
]);

const RUINS_OF_AHNQIRAJ = scaffold("aq20", [
  ["kurinnaxx", "Kurinnaxx", 718, 15742],
  ["rajaxx", "General Rajaxx", 719, 15376],
  ["moam", "Moam", 720, 15392],
  ["buru", "Buru the Gorger", 721, 15654],
  ["ayamiss", "Ayamiss the Hunter", 722, 15431],
  ["ossirian", "Ossirian the Unscarred", 723, 15432],
]);

const TEMPLE_OF_AHNQIRAJ = scaffold("aq40", [
  ["skeram", "The Prophet Skeram", 709, 15345],
  ["bug-trio", "Silithid Royalty", 710, 15657, ["Princess Yauj", "Vem", "Lord Kri"]],
  ["sartura", "Battleguard Sartura", 711, 15583],
  ["fankriss", "Fankriss the Unyielding", 712, 15743],
  ["viscidus", "Viscidus", 713, 15686],
  ["huhuran", "Princess Huhuran", 714, 15739],
  ["twin-emperors", "Twin Emperors", 715, 15778, ["Emperor Vek'lor", "Emperor Vek'nilash"]],
  ["ouro", "Ouro", 716, 15509],
  ["cthun", "C'Thun", 717, 15556, ["Eye of C'Thun"]],
]);

// Display IDs from the Wrath of the Lich King journal; Sapphiron's there is a later remodel, so none is used.
const NAXXRAMAS = scaffold("naxx", [
  ["anubrekhan", "Anub'Rekhan", 1107, 15931],
  ["faerlina", "Grand Widow Faerlina", 1110, 15940],
  ["maexxna", "Maexxna", 1116, 15928],
  ["noth", "Noth the Plaguebringer", 1117, 16590],
  ["heigan", "Heigan the Unclean", 1112, 16309],
  ["loatheb", "Loatheb", 1115, 16110],
  ["razuvious", "Instructor Razuvious", 1113, 16582],
  ["gothik", "Gothik the Harvester", 1109, 16279],
  ["four-horsemen", "The Four Horsemen", 1121, 16155, ["Thane Korth'azz", "Lady Blaumeux", "Sir Zeliek", "Highlord Mograine"]],
  ["patchwerk", "Patchwerk", 1118, 16174],
  ["grobbulus", "Grobbulus", 1111, 16035],
  ["gluth", "Gluth", 1108, 16064],
  ["thaddius", "Thaddius", 1120, 16137],
  ["sapphiron", "Sapphiron", 1119, null],
  ["kelthuzad", "Kel'Thuzad", 1114, 15945],
]);

export const RAID_BOSSES: Boss[] = [...MOLTEN_CORE, ...ONYXIA, ...BLACKWING_LAIR, ...ZUL_GURUB, ...RUINS_OF_AHNQIRAJ, ...TEMPLE_OF_AHNQIRAJ, ...NAXXRAMAS];

export const BOSSES: Boss[] = [...DUNGEON_BOSSES, ...RAID_BOSSES];
