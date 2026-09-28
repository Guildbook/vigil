import type { AuraDef, RotationModel, SpellDef } from "./types";

const SEALS = [
  ["seal-of-righteousness", "Seal of Righteousness"],
  ["seal-of-the-crusader", "Seal of the Crusader"],
  ["seal-of-command", "Seal of Command"],
  ["seal-of-wisdom", "Seal of Wisdom"],
  ["seal-of-light", "Seal of Light"],
  ["seal-of-justice", "Seal of Justice"],
] as const;

const sealSpells: SpellDef[] = SEALS.map(([key, label]) => ({ key, label, names: [label], gcd: true }));

const sealAuras: AuraDef[] = SEALS.map(([key, label]) => ({
  key,
  label,
  names: [label],
  on: "player",
  group: "seal",
  scored: key === "seal-of-righteousness",
  targetUptime: key === "seal-of-righteousness" ? 0.95 : undefined,
  appliedBy: key,
  durationMs: 30_000,
}));

/**
 * Levelling Paladin (no spec yet): keep a seal up, Judge on cooldown, never stop auto-attacking.
 * Ret, Prot and Holy extend this with their own spells, a healing metric and mana efficiency.
 */
export const paladinLeveling: RotationModel = {
  id: "paladin-leveling",
  label: "Paladin (levelling)",
  wowClass: "paladin",
  spec: null,
  role: "melee",
  metric: "damage",
  resource: "mana",
  spells: [
    ...sealSpells,
    {
      key: "judgement",
      label: "Judgement",
      names: ["Judgement", "Judgment"],
      effectNames: [
        "Judgement of Righteousness",
        "Judgement of Command",
        "Judgement of Justice",
        "Judgement of the Crusader",
        "Judgement of Wisdom",
        "Judgement of Light",
      ],
      gcd: true,
      cooldownMs: 10_000,
      trackCooldown: true,
      mayConsume: "seal",
    },
    { key: "holy-strike", label: "Holy Strike", names: ["Holy Strike"], gcd: true, cooldownMs: 12_000, trackCooldown: true },
    { key: "crusader-strike", label: "Crusader Strike", names: ["Crusader Strike"], gcd: true, cooldownMs: 6000, trackCooldown: true },
  ],
  auras: [
    ...sealAuras,
    {
      key: "blessing",
      label: "Blessing",
      names: ["Blessing of Might", "Blessing of Wisdom", "Blessing of Kings", "Blessing of Sanctuary"],
      on: "player",
      group: "blessing",
      anySource: true,
    },
  ],
  procs: [],
  priority: [
    {
      spell: "seal-of-righteousness",
      label: "Seal up when no seal is active",
      when: [{ kind: "auraMissing", aura: "seal" }],
      accepts: SEALS.map(([key]) => key),
    },
    { spell: "judgement", label: "Judgement on cooldown", when: [{ kind: "auraActive", aura: "seal" }] },
    { spell: "holy-strike", label: "Holy Strike on cooldown" },
    { spell: "crusader-strike", label: "Crusader Strike on cooldown" },
  ],
  threat: { stanceMultiplier: 1, healingMultiplier: 0.5 },
  extras: ["swingContinuity", "sealCadence"],
  detect: ["seal-of-righteousness", "judgement", "holy-strike", "seal-of-the-crusader"],
  assumptions: [
    "Any seal satisfies the seal step; Seal of Righteousness is the one whose uptime is scored.",
    "Whether Judgement consumes the seal is read from the log (Forever keeps the seal; Classic removes it).",
    "Lost auto-attacks are counted from gaps longer than one and a half median swing intervals.",
  ],
};
