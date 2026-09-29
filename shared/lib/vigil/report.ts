import { z } from "zod";
import { LOG_GAME_VERSIONS } from "./game-version";
import { vigilSnapshotSchema } from "./saved-variables";

/** Bumped when the report shape changes; the report page reads every version it knows. */
export const REPORT_VERSION = 1;

/** Server actions accept 1 MB bodies; one fight's report must stay well under that. */
export const MAX_REPORT_BYTES = 900_000;

const n = z.number();
const nn = z.number().nonnegative();
const ratio = z.number().min(0).max(1);
const label = z.string().min(1).max(120);
const interval = z.tuple([nn, nn]);

const spellStat = z.object({
  name: label,
  spellId: z.number().int().nullable(),
  casts: nn,
  hits: nn,
  crits: nn,
  misses: nn,
  damage: nn,
  healing: nn,
  overheal: nn,
  threat: n,
});

export const fightReportSchema = z.object({
  version: z.literal(REPORT_VERSION),
  /** The game the log came from (see game-version.ts); absent from older uploads, where the server derives it from `log`. */
  gameVersion: z.enum(LOG_GAME_VERSIONS).nullish(),
  fight: z.object({
    label,
    kind: z.enum(["boss", "trash"]),
    encounter: z
      .object({ id: z.number().int(), name: label, difficulty: z.number().int().optional(), success: z.boolean().optional() })
      .optional(),
    startedAt: z.iso.datetime(),
    durationMs: z.number().int().positive(),
    targets: z
      .array(
        z.object({
          name: label,
          npcId: z.number().int().nullable(),
          damageTaken: nn,
          damageDealt: nn,
          died: z.boolean(),
        }),
      )
      .max(25),
  }),
  player: z.object({ name: label, guid: z.string().max(64), level: z.number().int().min(1).max(100).nullable() }),
  log: z.object({
    version: z.number().int().nullable(),
    advanced: z.boolean(),
    build: z.string().max(40).nullable(),
    projectId: z.number().int().nullable(),
    /** The `_flavor_` install folder the log was read from, when known. */
    flavor: z.string().max(40).nullish(),
  }),
  model: z.object({ id: z.string().max(40), label, metric: z.enum(["damage", "threat", "healing"]) }).nullable(),
  totals: z.object({
    damage: nn,
    healing: nn,
    overheal: nn,
    damageTaken: nn,
    threat: n,
    dps: nn,
    hps: nn,
    tps: n,
  }),
  activity: z.object({
    gcdMs: nn,
    gcdCasts: nn,
    activeMs: nn,
    gcdUsage: ratio,
    /** Time off the global cooldown while a priority ability was ready (model reports only). */
    readyIdleMs: nn.nullable(),
    idleGaps: z.array(interval).max(200),
  }),
  casts: z
    .array(z.object({ t: nn, name: label, gcd: z.boolean(), verdict: z.enum(["match", "miss", "outside"]).optional() }))
    .max(3000),
  spells: z.array(spellStat).max(80),
  adherence: z
    .object({
      pct: ratio,
      decisions: nn,
      matched: nn,
      steps: z.array(z.object({ label, expected: nn, done: nn })).max(20),
      misses: z.array(z.object({ t: nn, expected: label, actual: label })).max(60),
    })
    .nullable(),
  uptimes: z
    .array(
      z.object({
        key: z.string().max(40),
        label,
        on: z.enum(["player", "target"]),
        pct: ratio,
        targetPct: ratio,
        scored: z.boolean(),
        intervals: z.array(interval).max(400),
      }),
    )
    .max(20),
  procs: z.array(z.object({ key: z.string().max(40), label, windows: nn, usable: nn, used: nn, pct: ratio })).max(10),
  cooldowns: z.array(z.object({ key: z.string().max(40), label, casts: nn, possible: nn, pct: ratio })).max(20),
  swings: z.object({ count: nn, medianIntervalMs: nn, lostSwings: nn }).nullable(),
  resource: z
    .object({
      name: z.string().max(20),
      max: nn,
      samples: z.array(z.tuple([nn, n])).max(500),
      timeAtCapMs: nn,
      wastedEstimate: nn,
      gained: nn,
      spent: nn,
    })
    .nullable(),
  extras: z.object({
    rageDump: z.object({ threshold: nn, opportunities: nn, used: nn, pct: ratio }).optional(),
    seal: z
      .object({
        judgements: nn,
        consumesSeal: z.boolean(),
        medianJudgementIntervalMs: nn.nullable(),
        timeWithoutSealMs: nn,
      })
      .optional(),
  }),
  estimate: z
    .object({
      metric: z.enum(["damage", "threat", "healing"]),
      actual: n,
      estimated: n,
      efficiency: ratio,
      gains: z.array(z.object({ label, amount: n })).max(20),
      simCasts: z.array(z.object({ label, actual: nn, simulated: nn })).max(20),
      assumptions: z.array(z.string().max(400)).max(20),
    })
    .nullable(),
  score: z.object({ overall: z.number().int().min(0).max(100), parts: z.array(z.object({ label, value: ratio })).max(10) }),
  snapshot: vigilSnapshotSchema.nullable().optional(),
  notes: z.array(z.string().max(400)).max(20),
});

export type FightReport = z.infer<typeof fightReportSchema>;
