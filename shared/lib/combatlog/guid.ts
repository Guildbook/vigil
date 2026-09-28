export const EMPTY_GUID = "0000000000000000";

/** COMBATLOG_OBJECT_* flag bits used here. */
export const FLAGS = {
  affiliationMine: 0x1,
  reactionFriendly: 0x10,
  reactionHostile: 0x40,
  controlPlayer: 0x100,
  typePlayer: 0x400,
  typeNpc: 0x800,
  typePet: 0x1000,
} as const;

export function parseFlags(value: string | undefined): number {
  if (!value) return 0;
  const n = value.startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function isPlayerGuid(guid: string | undefined): boolean {
  return Boolean(guid?.startsWith("Player-"));
}

export function isNpcGuid(guid: string | undefined): boolean {
  return Boolean(guid && (guid.startsWith("Creature-") || guid.startsWith("Vehicle-")));
}

export function isGuidLike(value: string | undefined): boolean {
  return Boolean(value && (value === EMPTY_GUID || /^[A-Za-z]+-[0-9A-Fa-f-]+$/.test(value)));
}

/** `Creature-0-[server]-[instance]-[zone]-[npcId]-[spawn]`: the NPC id, or null. */
export function npcIdFromGuid(guid: string | undefined): number | null {
  if (!isNpcGuid(guid)) return null;
  const id = Number(guid!.split("-")[5]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Retail writes player names as `Name-Realm-Region`; keep the character name. */
export function shortName(name: string | undefined): string {
  if (!name || name === "nil") return "Unknown";
  return name.split("-")[0]!.trim() || name;
}
