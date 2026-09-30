/**
 * Which game a combat log came from, from its header (PROJECT_ID, BUILD_VERSION) and the install folder it was
 * read from (`_anniversary_`, `_classic_era_`...). Self-contained so the Vigil app can vendor it unchanged.
 *
 * The values match the site's guild versions (`src/lib/game-versions.ts`). Known project ids: 1 retail, 2 Classic
 * Era, 5 TBC (the Anniversary client; the 2021 TBC Classic that also used 5 is gone), 18 WoW: Forever (1.60.x
 * builds, seen in the beta), 19 Mists progression.
 */

export const LOG_GAME_VERSIONS = ["forever", "anniversary", "era", "seasonal", "progression"] as const;
export type LogGameVersion = (typeof LOG_GAME_VERSIONS)[number];

export const LOG_VERSION_LABELS: Record<LogGameVersion, string> = {
  forever: "WoW: Forever",
  anniversary: "TBC Anniversary",
  era: "Classic Era",
  seasonal: "Season of Discovery",
  progression: "Classic progression",
};

export const FOREVER_PROJECT_IDS: readonly number[] = [18];

const PROJECT_RETAIL = 1;
const PROJECT_ERA = 2;
const PROJECT_TBC = 5;
const PROJECT_MISTS = 19;

export interface GameVersionHints {
  projectId?: number | null;
  build?: string | null;
  /** The `_flavor_` install folder the log was read from, when known. */
  flavor?: string | null;
}

export interface DetectedGameVersion {
  /** Null when the log does not say (older logs, a 1.x build without a folder hint) or the game is unsupported. */
  version: LogGameVersion | null;
  /** "header" when the log itself decides, "folder" when the install folder does. */
  source: "header" | "folder" | null;
}

const UNKNOWN: DetectedGameVersion = { version: null, source: null };

function major(build: string | null | undefined): number | null {
  const n = Number(build?.split(".")[0]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Forever ships 1.60.x builds; Classic Era is on 1.15.x. */
const isForeverBuild = (build: string | null | undefined) => /^1\.([6-9]\d|\d{3,})\./.test(build ?? "");

function versionFromFlavor(flavor: string): LogGameVersion | null {
  if (/forever/i.test(flavor) || /^_classic_beta_$/i.test(flavor)) return "forever";
  if (/^_anniversary_$/i.test(flavor)) return "anniversary";
  if (/^_classic_era(_ptr)?_$/i.test(flavor)) return "era";
  return null;
}

export function detectGameVersion(hints: GameVersionHints): DetectedGameVersion {
  const { projectId, build, flavor } = hints;
  const buildMajor = major(build);
  if (projectId === PROJECT_RETAIL || projectId === PROJECT_MISTS) return UNKNOWN;
  if (buildMajor !== null && buildMajor >= 3) return UNKNOWN;
  if (projectId != null && FOREVER_PROJECT_IDS.includes(projectId)) return { version: "forever", source: "header" };
  if (projectId === PROJECT_TBC || buildMajor === 2) return { version: "anniversary", source: "header" };
  if (projectId !== PROJECT_ERA && isForeverBuild(build)) return { version: "forever", source: "header" };

  // Left: a 1.x build or no build at all. Era and older Forever betas share 1.15.x, so only the folder tells them apart.
  const fromFolder = flavor ? versionFromFlavor(flavor) : null;
  if (!fromFolder || (fromFolder === "anniversary" && buildMajor !== null)) return UNKNOWN;
  if (projectId != null && projectId !== PROJECT_ERA && fromFolder !== "forever") return UNKNOWN;
  return { version: fromFolder, source: "folder" };
}

/** The `_flavor_` folder in a combat log path, as in `.../World of Warcraft/_anniversary_/Logs/WoWCombatLog.txt`. */
export function flavorFromPath(logPath: string | null | undefined): string | null {
  if (!logPath) return null;
  const parts = logPath.split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^_[a-z0-9_]+_$/i.test(parts[i]!)) return parts[i]!;
  }
  return null;
}

/** The report's stated version, else one derived from its log block (reports from Vigil builds that did not send it). */
export function reportGameVersion(report: {
  gameVersion?: LogGameVersion | null;
  log: { build: string | null; projectId: number | null; flavor?: string | null };
}): LogGameVersion | null {
  if (report.gameVersion) return report.gameVersion;
  return detectGameVersion(report.log).version;
}
