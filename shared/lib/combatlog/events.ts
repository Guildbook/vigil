import { FLAGS, isNpcGuid } from "./guid";
import type { CombatEvent } from "./types";

export const isDamage = (ev: CombatEvent) =>
  ev.type.endsWith("_DAMAGE") && ev.type !== "SWING_DAMAGE_LANDED" && ev.type !== "ENVIRONMENTAL_DAMAGE";
export const isMiss = (ev: CombatEvent) => ev.type.endsWith("_MISSED");
export const isHeal = (ev: CombatEvent) => ev.type.endsWith("_HEAL");
export const isSwing = (ev: CombatEvent) => ev.type === "SWING_DAMAGE" || ev.type === "SWING_MISSED";
export const isCastSuccess = (ev: CombatEvent) => ev.type === "SPELL_CAST_SUCCESS";
export const isAura = (ev: CombatEvent) => ev.type.startsWith("SPELL_AURA_");

/** An NPC that is not friendly: fights and damage count against these. */
export function isHostileNpc(unit: CombatEvent["src"]): boolean {
  if (!unit) return false;
  if (unit.flags & FLAGS.reactionFriendly) return false;
  if (unit.flags & FLAGS.typePlayer) return false;
  return isNpcGuid(unit.guid) || Boolean(unit.flags & (FLAGS.typeNpc | FLAGS.reactionHostile));
}

/** Display name for the ability behind an event; auto-attacks are "Melee". */
export function abilityName(ev: CombatEvent): string {
  if (ev.type.startsWith("SWING_")) return "Melee";
  return ev.spellName ?? `Spell ${ev.spellId ?? "?"}`;
}

/** Heal amounts include overhealing; this is what actually landed. */
export const effectiveHeal = (ev: CombatEvent) => Math.max(0, (ev.amount ?? 0) - (ev.overheal ?? 0));
