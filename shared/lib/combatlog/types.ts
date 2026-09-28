import type { LogHeader } from "./tokenizer";

export type { LogHeader };

export interface LogUnit {
  guid: string;
  name: string;
  flags: number;
}

/** The advanced-logging block: the state of `guid` (source or destination) when the event happened. */
export interface AdvancedInfo {
  guid: string;
  hp?: number;
  maxHp?: number;
  attackPower?: number;
  spellPower?: number;
  armor?: number;
  powerType?: number[];
  power?: number[];
  maxPower?: number[];
  powerCost?: number;
  x?: number;
  y?: number;
  level?: number;
}

export interface CombatEvent {
  /** Epoch milliseconds. */
  t: number;
  type: string;
  src: LogUnit | null;
  dst: LogUnit | null;
  spellId?: number;
  spellName?: string;
  school?: number;
  adv?: AdvancedInfo;
  amount?: number;
  overkill?: number;
  absorbed?: number;
  blocked?: number;
  resisted?: number;
  critical?: boolean;
  offHand?: boolean;
  overheal?: number;
  missType?: string;
  auraType?: string;
  /** Stack count for SPELL_AURA_APPLIED_DOSE / REMOVED_DOSE. */
  stacks?: number;
  overEnergize?: number;
  powerType?: number;
  encounter?: { id: number; name: string; difficulty?: number; success?: boolean; durationMs?: number };
}
