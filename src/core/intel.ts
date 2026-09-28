import { BOSSES, DUNGEONS, INSTANCES, RAIDS, type Boss, type BossAbility, type Instance, type InstanceId } from "../data/bosses";

/** Lookups over the boss intel in src/data/bosses.ts (raids) and src/data/dungeons/ (dungeons). */

const byEncounter = new Map(
  BOSSES.flatMap((b) => [...(b.encounterId === null ? [] : [b.encounterId]), ...(b.altEncounterIds ?? [])].map((id) => [id, b] as const)),
);
const byNpc = new Map(BOSSES.flatMap((b) => b.npcIds.map((id) => [id, b] as const)));
const byName = new Map(BOSSES.flatMap((b) => b.unitNames.map((n) => [n.toLowerCase(), b] as const)));
const byKey = new Map(BOSSES.map((b) => [b.key, b]));
const instances = new Map(INSTANCES.map((r) => [r.id, r]));

export const bossForEncounter = (encounterId: number): Boss | null => byEncounter.get(encounterId) ?? null;
export const bossByKey = (key: string): Boss | null => byKey.get(key) ?? null;
export const instanceById = (id: InstanceId): Instance => instances.get(id)!;

/** The boss a hostile unit is, by NPC ID or by name (logs without ENCOUNTER_START, or a wrong NPC ID). */
export function bossForUnit(npcId: number | null, name: string | undefined): Boss | null {
  return (npcId !== null ? byNpc.get(npcId) : undefined) ?? (name ? byName.get(name.toLowerCase()) : undefined) ?? null;
}

/** The first known boss among a fight's targets (the analysed report lists them by damage exchanged). */
export function bossAmong(targets: { npcId: number | null; name: string }[]): Boss | null {
  for (const t of targets) {
    const boss = bossForUnit(t.npcId, t.name);
    if (boss) return boss;
  }
  return null;
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

export interface InstanceGroup {
  instance: Instance;
  bosses: Boss[];
}

export function bossesByInstance(kind?: Instance["kind"]): InstanceGroup[] {
  const list = kind === "dungeon" ? DUNGEONS : kind === "raid" ? RAIDS : INSTANCES;
  return list.map((instance) => ({ instance, bosses: BOSSES.filter((b) => b.instance === instance.id) }));
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Bosses matching a search, grouped by instance. Every word must match the boss's name, unit names, instance, or
 * one of its abilities ("vancleef", "brd emperor", "rhahkzor"). Apostrophes and punctuation are ignored.
 */
export function searchBosses(query: string): InstanceGroup[] {
  const words = fold(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  const hay = (b: Boss) => {
    const inst = instanceById(b.instance);
    return fold([b.name, ...b.unitNames, inst.name, inst.short, ...b.abilities.map((a) => a.name)].join(" "));
  };
  return bossesByInstance()
    .map(({ instance, bosses }) => ({ instance, bosses: bosses.filter((b) => words.every((w) => hay(b).includes(w))) }))
    .filter((g) => g.bosses.length > 0);
}
