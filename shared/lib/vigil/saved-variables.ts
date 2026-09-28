import { z } from "zod";

/**
 * Parse Vigil SavedVariables (`WTF/Account/<account>/SavedVariables/Vigil.lua`). The addon keeps its
 * snapshots as a JSON string in `VigilDB.machineExport`; the copy window shows the same JSON, so both
 * a SavedVariables file and pasted JSON are accepted.
 */

const num = z.number().finite().nullish();

export const vigilSnapshotSchema = z.object({
  at: z.number().int().nonnegative(),
  name: z.string().min(1).max(64),
  realm: z.string().max(64).nullish(),
  guid: z.string().max(64).nullish(),
  class: z.string().max(32).nullish(),
  race: z.string().max(32).nullish(),
  level: z.number().int().min(1).max(100).nullish(),
  reason: z.string().max(32).nullish(),
  stats: z.record(z.string(), num).catch({}).default({}),
  gear: z
    .array(z.object({ slot: z.number().int(), itemId: z.number().int(), enchantId: z.number().int().nullish() }))
    .catch([])
    .default([]),
  talents: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).catch([]).default([]),
  talentSource: z.string().max(16).nullish(),
});

export type VigilSnapshot = z.infer<typeof vigilSnapshotSchema>;

export function unescapeLuaString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === "n") {
        out += "\n";
        i++;
      } else if (n === "r") {
        out += "\r";
        i++;
      } else if (n === '"') {
        out += '"';
        i++;
      } else if (n === "\\") {
        out += "\\";
        i++;
      } else {
        out += s[i];
      }
    } else {
      out += s[i];
    }
  }
  return out;
}

/** The raw JSON text of `["machineExport"] = "..."`, or null when the file has none. */
export function extractMachineExport(text: string): string | null {
  const m = text.match(/\[["']machineExport["']\]\s*=\s*"((?:\\.|[^"\\])*)"/);
  return m ? unescapeLuaString(m[1]) : null;
}

/** Snapshots from a SavedVariables file or pasted export JSON. Invalid entries are skipped, never fatal. */
export function parseVigilSnapshots(text: string): VigilSnapshot[] {
  const json = extractMachineExport(text) ?? text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { snapshots?: unknown }).snapshots)
      ? (parsed as { snapshots: unknown[] }).snapshots
      : [];
  const out: VigilSnapshot[] = [];
  for (const item of list) {
    const r = vigilSnapshotSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The snapshot that best describes `name` at `atMs`: the latest one taken at or before the fight,
 * else the earliest one after it. Names compare case-insensitively without the realm suffix.
 */
export function snapshotFor(snapshots: VigilSnapshot[], name: string, atMs: number): VigilSnapshot | null {
  const wanted = name.split("-")[0]!.trim().toLowerCase();
  const mine = snapshots.filter((s) => s.name.split("-")[0]!.trim().toLowerCase() === wanted);
  if (mine.length === 0) return null;
  const at = atMs / 1000;
  const before = mine.filter((s) => s.at <= at);
  return before.at(-1) ?? mine[0]!;
}
