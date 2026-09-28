import { BOSSES, RAIDS, type Boss, type BossAbility, type Raid, type RaidId } from "../data/bosses";

/** Lookups over the boss intel in src/data/bosses.ts. */

const byEncounter = new Map(BOSSES.map((b) => [b.encounterId, b]));
const byNpc = new Map(BOSSES.flatMap((b) => b.npcIds.map((id) => [id, b] as const)));
const byName = new Map(BOSSES.flatMap((b) => b.unitNames.map((n) => [n.toLowerCase(), b] as const)));
const byKey = new Map(BOSSES.map((b) => [b.key, b]));
const raids = new Map(RAIDS.map((r) => [r.id, r]));

export const bossForEncounter = (encounterId: number): Boss | null => byEncounter.get(encounterId) ?? null;
export const bossByKey = (key: string): Boss | null => byKey.get(key) ?? null;
export const raidById = (id: RaidId): Raid => raids.get(id)!;

/** The boss a hostile unit is, by NPC ID or by name (logs without ENCOUNTER_START, or a wrong NPC ID). */
export function bossForUnit(npcId: number | null, name: string | undefined): Boss | null {
  return (npcId !== null ? byNpc.get(npcId) : undefined) ?? (name ? byName.get(name.toLowerCase()) : undefined) ?? null;
}

/** The intel entry for an ability seen in a boss fight, by spell ID first, then by name. */
export function matchAbility(boss: Boss, spellId: number | null, name: string): BossAbility | null {
  if (spellId !== null) {
    const hit = boss.abilities.find((a) => a.spellIds.includes(spellId));
    if (hit) return hit;
  }
  const n = name.toLowerCase();
  return boss.abilities.find((a) => a.name.toLowerCase() === n || a.logNames?.some((l) => l.toLowerCase() === n)) ?? null;
}

/** Whether an NPC belongs to a boss fight (the boss or one of its listed adds). */
export function isEncounterUnit(boss: Boss, npcId: number | null): boolean {
  return npcId !== null && (boss.npcIds.includes(npcId) || Boolean(boss.addNpcIds?.includes(npcId)));
}

export function bossesByRaid(): { raid: Raid; bosses: Boss[] }[] {
  return RAIDS.map((raid) => ({ raid, bosses: BOSSES.filter((b) => b.raid === raid.id) }));
}
