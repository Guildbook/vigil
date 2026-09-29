// Pure helpers for scripts/generate-icon-data.ts: turn Blizzard's WoW Classic client tables (DB2 exports) into
// the spell icon map the app ships in src/data/. Kept apart from the CLI so tests can run them on fixtures.
import type { WowClass } from "@/lib/game";

/** Classic Era client build the committed data was generated from. */
export const CLASSIC_ERA_BUILD = "1.15.9.69722";
/** TBC Anniversary client build merged in after Classic Era (wago.tools product `wow_anniversary`). */
export const TBC_ANNIVERSARY_BUILD = "2.5.6.69795";

/** SpellClassOptions.SpellClassSet to class (the client's spell families). */
export const CLASS_SETS: Record<number, WowClass> = {
  3: "mage",
  4: "warrior",
  5: "warlock",
  6: "priest",
  7: "druid",
  8: "rogue",
  9: "hunter",
  10: "paladin",
  11: "shaman",
};

export type Row = Record<string, string>;

export interface IconData {
  source: string;
  build: string;
  /** Distinct icon names, as used by Blizzard's render CDN (`/icons/{size}/{name}.jpg`). */
  icons: string[];
  /** Spell ID to index in `icons`. */
  spells: Record<string, number>;
  /** Lowercased class spell name to index in `icons`, for places that only know an ability's name. */
  names: Record<string, number>;
  /** Class spell IDs, for telling a player's class from what they cast. */
  classes: Record<WowClass, number[]>;
  /** Icons the render CDN does not serve (checked with --verify-cdn); the app shows its fallback for these. */
  missing: string[];
}

/** RFC 4180 CSV, as wago.tools exports DB2 tables: a header row, quoted fields with doubled quotes. */
export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.filter((r) => r.length > 1 || r[0]).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** `Ability_Warrior_Sunder.blp` (or a stray `.tga.blp`) to the CDN's `ability_warrior_sunder`. */
export function iconName(fileName: string): string | null {
  const name = fileName.split(".")[0]!.trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(name) ? name : null;
}

export interface Tables {
  manifest: Row[];
  spellMisc: Row[];
  spellNames: Row[];
  classOptions: Row[];
}

export function buildIconData(t: Tables, meta: { source: string; build: string }): IconData {
  const files = new Map<string, string>();
  for (const r of t.manifest) {
    if (!r.FilePath?.toLowerCase().startsWith("interface\\icons")) continue;
    const name = iconName(r.FileName ?? "");
    if (name) files.set(r.ID!, name);
  }
  const bySpell = new Map<number, string>();
  for (const r of t.spellMisc) {
    if (r.DifficultyID !== "0") continue;
    const icon = files.get(r.SpellIconFileDataID ?? "");
    // "temp" is the placeholder the client uses for trainer and internal spells.
    if (icon && icon !== "temp") bySpell.set(Number(r.SpellID), icon);
  }
  const names = new Map(t.spellNames.map((r) => [Number(r.ID), r.Name_lang ?? ""]));
  const icons = [...new Set(bySpell.values())].sort();
  const index = new Map(icons.map((name, i) => [name, i]));

  const spells: Record<string, number> = {};
  for (const id of [...bySpell.keys()].sort((a, b) => a - b)) spells[id] = index.get(bySpell.get(id)!)!;

  const classes = Object.fromEntries(Object.values(CLASS_SETS).map((c) => [c, [] as number[]])) as unknown as Record<WowClass, number[]>;
  const nameIcons: Record<string, number> = {};
  const classRows = t.classOptions
    .map((r) => ({ id: Number(r.SpellID), cls: CLASS_SETS[Number(r.SpellClassSet)] }))
    .filter((r) => r.cls && names.has(r.id))
    .sort((a, b) => a.id - b.id);
  for (const { id, cls } of classRows) {
    if (!classes[cls!].includes(id)) classes[cls!].push(id);
    const name = names.get(id)!.toLowerCase();
    const icon = bySpell.get(id);
    // Rank 1 (the lowest ID) names the icon; ranks share it.
    if (name && icon && nameIcons[name] === undefined) nameIcons[name] = index.get(icon)!;
  }
  return { ...meta, icons, spells, names: nameIcons, classes, missing: [] };
}

/**
 * Several clients' data in one map. Earlier builds win where they disagree, so spell IDs and names keep their
 * Classic Era icons and later builds only add what the earlier ones lack.
 */
export function mergeIconData(parts: IconData[], meta: { source: string; build: string }): IconData {
  const bySpell = new Map<number, string>();
  const byName = new Map<string, string>();
  const classes = Object.fromEntries(Object.values(CLASS_SETS).map((c) => [c, new Set<number>()])) as unknown as Record<WowClass, Set<number>>;
  const classed = new Set<number>();
  for (const part of parts) {
    for (const [id, i] of Object.entries(part.spells)) if (!bySpell.has(Number(id))) bySpell.set(Number(id), part.icons[i]!);
    for (const [name, i] of Object.entries(part.names)) if (!byName.has(name)) byName.set(name, part.icons[i]!);
    for (const [cls, ids] of Object.entries(part.classes)) {
      for (const id of ids) {
        if (classed.has(id)) continue;
        classed.add(id);
        classes[cls as WowClass]?.add(id);
      }
    }
  }
  const icons = [...new Set([...bySpell.values(), ...byName.values()])].sort();
  const index = new Map(icons.map((name, i) => [name, i]));
  const spells: Record<string, number> = {};
  for (const id of [...bySpell.keys()].sort((a, b) => a - b)) spells[id] = index.get(bySpell.get(id)!)!;
  const names: Record<string, number> = {};
  for (const [name, icon] of byName) names[name] = index.get(icon)!;
  const classIds = Object.fromEntries(
    Object.entries(classes).map(([cls, ids]) => [cls, [...ids].sort((a, b) => a - b)]),
  ) as Record<WowClass, number[]>;
  return { ...meta, icons, spells, names, classes: classIds, missing: [] };
}

/** The icon name in a Game Data API media document (`/data/wow/media/spell/{id}`), or null. */
export function iconFromMedia(doc: unknown): string | null {
  const assets = (doc as { assets?: { key?: string; value?: string }[] } | null)?.assets;
  const url = assets?.find((a) => a.key === "icon")?.value;
  const m = url ? /\/icons\/\d+\/([^/]+)\.jpg$/.exec(url) : null;
  return m ? iconName(m[1]!) : null;
}
