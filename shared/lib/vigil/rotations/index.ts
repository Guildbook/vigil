import type { WowClass } from "@/lib/game";
import { paladinLeveling } from "./paladin-leveling";
import { protectionWarrior } from "./protection-warrior";
import type { RotationModel } from "./types";

export type { RotationModel } from "./types";

export const ROTATION_MODELS: readonly RotationModel[] = [protectionWarrior, paladinLeveling];

export function getModel(id: string | null | undefined): RotationModel | null {
  return ROTATION_MODELS.find((m) => m.id === id) ?? null;
}

/** Picks the model whose signature spells the player cast most; the class narrows it when known. */
export function detectModel(spellNames: string[], wowClass?: WowClass | null): RotationModel | null {
  const cast = new Set(spellNames.map((s) => s.toLowerCase()));
  let best: RotationModel | null = null;
  let bestHits = 0;
  for (const model of ROTATION_MODELS) {
    if (wowClass && model.wowClass !== wowClass) continue;
    const hits = model.detect.filter((key) =>
      model.spells.find((s) => s.key === key)?.names.some((n) => cast.has(n.toLowerCase())),
    ).length;
    if (hits > bestHits) {
      best = model;
      bestHits = hits;
    }
  }
  return best;
}
