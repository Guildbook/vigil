export const CLASSES = [
  "warrior",
  "paladin",
  "hunter",
  "rogue",
  "priest",
  "shaman",
  "mage",
  "warlock",
  "druid",
] as const;
export type WowClass = (typeof CLASSES)[number];

export const CLASS_INFO: Record<WowClass, { label: string; color: string; specs: readonly string[] }> = {
  warrior: { label: "Warrior", color: "#C69B6D", specs: ["Arms", "Fury", "Protection"] },
  paladin: { label: "Paladin", color: "#F48CBA", specs: ["Holy", "Protection", "Retribution"] },
  hunter: { label: "Hunter", color: "#AAD372", specs: ["Beast Mastery", "Marksmanship", "Survival"] },
  rogue: { label: "Rogue", color: "#FFF468", specs: ["Assassination", "Combat", "Subtlety"] },
  priest: { label: "Priest", color: "#FFFFFF", specs: ["Discipline", "Holy", "Shadow"] },
  shaman: { label: "Shaman", color: "#0070DD", specs: ["Elemental", "Enhancement", "Restoration"] },
  mage: { label: "Mage", color: "#3FC7EB", specs: ["Arcane", "Fire", "Frost"] },
  warlock: { label: "Warlock", color: "#8788EE", specs: ["Affliction", "Demonology", "Destruction"] },
  druid: { label: "Druid", color: "#FF7C0A", specs: ["Balance", "Feral", "Restoration"] },
};

export function isValidSpec(wowClass: WowClass, spec: string): boolean {
  return CLASS_INFO[wowClass].specs.includes(spec);
}

export const ROLES = ["tank", "healer", "melee", "ranged"] as const;
export type RaidRole = (typeof ROLES)[number];
export const ROLE_LABELS: Record<RaidRole, string> = {
  tank: "Tank",
  healer: "Healer",
  melee: "Melee DPS",
  ranged: "Ranged DPS",
};

export const fullName = (name: string, surname: string) => `${name} ${surname}`;

export const FACTIONS = ["alliance", "horde"] as const;
export type Faction = (typeof FACTIONS)[number];
export const FACTION_LABELS: Record<Faction, string> = { alliance: "Alliance", horde: "Horde" };

/**
 * WoW: Forever rulesets. Forever has no realms: players pick a ruleset instead, and each ruleset is its own
 * ecosystem (no cross-ruleset grouping, factions still separate), so a guild belongs to exactly one.
 * Source: Blizzard, "Choose Your Ruleset in World of Warcraft: Forever"
 * (https://news.blizzard.com/en-us/article/24302070/choose-your-ruleset-in-world-of-warcraft-forever, September 2026).
 * Normal, PvP and Roleplaying launch on Nov 4, 2026; Hardcore arrives "sometime after launch".
 * Correct this list (and `RULESET_BY_REALM_TYPE`) here if Blizzard changes it.
 */
export const RULESETS = ["normal", "pvp", "rp", "hardcore"] as const;
export type Ruleset = (typeof RULESETS)[number];
export const RULESET_INFO: Record<Ruleset, { label: string; description: string; note?: string }> = {
  normal: { label: "Normal", description: "Questing and cooperation, PvP when you choose it" },
  pvp: { label: "PvP", description: "Open-world conflict in contested territory" },
  rp: { label: "Roleplaying", description: "For players who lean into the fantasy of Azeroth" },
  hardcore: { label: "Hardcore", description: "One life; death has lasting consequences", note: "Opens after launch" },
};

/**
 * Blizzard's Game Data realm `type.type` for each ruleset. Forever's realm types aren't published yet; these are
 * the values Classic realms use today. `BATTLENET_REALM_RULESETS` overrides them per realm without a code change.
 */
export const RULESET_BY_REALM_TYPE: Record<string, Ruleset> = {
  NORMAL: "normal",
  PVE: "normal",
  PVP: "pvp",
  RP: "rp",
  ROLEPLAYING: "rp",
  HARDCORE: "hardcore",
};

export const PROFESSIONS = [
  "alchemy",
  "blacksmithing",
  "enchanting",
  "engineering",
  "herbalism",
  "leatherworking",
  "mining",
  "skinning",
  "tailoring",
  "cooking",
  "first_aid",
  "fishing",
] as const;
export type Profession = (typeof PROFESSIONS)[number];
export const PROFESSION_LABELS: Record<Profession, string> = {
  alchemy: "Alchemy",
  blacksmithing: "Blacksmithing",
  enchanting: "Enchanting",
  engineering: "Engineering",
  herbalism: "Herbalism",
  leatherworking: "Leatherworking",
  mining: "Mining",
  skinning: "Skinning",
  tailoring: "Tailoring",
  cooking: "Cooking",
  first_aid: "First Aid",
  fishing: "Fishing",
};

export const MAX_LEVEL = 60;
export const MAX_PROFESSION_SKILL = 300;
export const MAX_IN_GAME_RANKS = 10;

/** World of Warcraft: Forever launch day (a Wednesday). Nothing happens in game before this date. */
export const WOWF_LAUNCH_DATE = "2026-11-04";

export const DAYS_OF_WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
