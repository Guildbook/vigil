import type { WowClass } from "@/lib/game";

/** [minimum level, value] pairs; the highest entry at or below the player's level applies. */
export type LevelTable = [number, number][];

export interface SpellDef {
  key: string;
  label: string;
  /** English names (every rank shares one). Matching is case-insensitive. */
  names: string[];
  /** Names its damage or healing is logged under when they differ from the cast (Judgement of Righteousness). */
  effectNames?: string[];
  /** Whether the ability triggers the global cooldown. */
  gcd: boolean;
  cooldownMs?: number;
  /** Resource cost used when the log has no cost for it. */
  cost?: number;
  /** Replaces the next white swing instead of casting (Heroic Strike). */
  nextSwing?: boolean;
  threat?: {
    /** Bonus threat added on each hit ("hit") or each successful cast that was not missed ("cast"). */
    bonus?: LevelTable;
    on?: "hit" | "cast";
    /** Multiplier on the ability's damage before stance modifiers. */
    damageMultiplier?: number;
  };
  /** Show in the cooldown usage table. */
  trackCooldown?: boolean;
  /** An aura (or group) this ability may remove when used; the engine checks the log to see whether it does. */
  mayConsume?: string;
}

export interface AuraDef {
  key: string;
  label: string;
  names: string[];
  on: "player" | "target";
  /** Auras sharing a group are interchangeable (any seal). */
  group?: string;
  /** Counted in the report's uptime bars and the score. */
  scored?: boolean;
  /** Uptime the model treats as full marks (Sunder on a short trash pull cannot reach 100%). */
  targetUptime?: number;
  /** For the replay: the spell that applies it and how long it lasts. */
  appliedBy?: string;
  durationMs?: number;
  maxStacks?: number;
  /** Count applications from any source (another warrior's Sunder still counts). */
  anySource?: boolean;
}

export type Condition =
  | { kind: "auraMissing"; aura: string }
  | { kind: "auraActive"; aura: string }
  | { kind: "stacksBelow"; aura: string; stacks: number }
  | { kind: "procActive"; proc: string }
  | { kind: "resourceAtLeast"; amount: number };

export interface PriorityRule {
  spell: string;
  label: string;
  when?: Condition[];
  /** Other spell keys that also satisfy this step (any seal for "seal up"). */
  accepts?: string[];
}

export interface ProcDef {
  key: string;
  label: string;
  /** The ability the proc enables. */
  spell: string;
  windowMs: number;
  /** "avoided": the player dodged, parried or blocked a hostile attack (Revenge). */
  trigger: "avoided";
}

export interface RotationModel {
  id: string;
  label: string;
  wowClass: WowClass;
  spec: string | null;
  role: "tank" | "melee" | "caster" | "healer";
  /** What the estimate compares: threat for tanks, damage for DPS, healing for healers. */
  metric: "damage" | "threat" | "healing";
  resource: "rage" | "mana" | "energy" | null;
  spells: SpellDef[];
  auras: AuraDef[];
  procs: ProcDef[];
  priority: PriorityRule[];
  threat: {
    /** Stance or form multiplier, applied when `stanceAura` is active or always when it is not set. */
    stanceMultiplier: number;
    stanceAura?: string;
    /** Threat per point of rage gained from energize events (Bloodrage). */
    perRageGained?: number;
    healingMultiplier: number;
  };
  /** Extra checks the report shows. */
  extras: Array<"swingContinuity" | "rageDump" | "sealCadence">;
  /** Rage at or above which a swing should have been Heroic Strike. */
  rageDumpAt?: number;
  /** Spell keys whose use suggests this model when picking one automatically. */
  detect: string[];
  assumptions: string[];
}
