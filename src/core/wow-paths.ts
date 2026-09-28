import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMBAT_LOG_PATTERN } from "./tailer";

/**
 * Finding the WoW Logs folder. Battle.net installs every Classic-tab game under one root, one `_flavor_`
 * folder each. Forever's folder name is not confirmed yet (the beta may be `_classic_beta_`, live perhaps
 * `_forever_`), so every `_*_` folder is a candidate; known names only decide the order and label.
 */

/** Common install roots (the folder holding `_classic_era_` and friends). From the AzerothOS importer. */
export function wowRootCandidates(platform: NodeJS.Platform = process.platform, home = os.homedir()): string[] {
  if (platform === "darwin") {
    return ["/Applications/World of Warcraft", path.join(home, "Applications", "World of Warcraft")];
  }
  if (platform === "win32") {
    const roots: string[] = [];
    for (const drive of ["C:", "D:", "E:"]) {
      roots.push(
        `${drive}\\Program Files (x86)\\World of Warcraft`,
        `${drive}\\Program Files\\World of Warcraft`,
        `${drive}\\World of Warcraft`,
        `${drive}\\Games\\World of Warcraft`,
      );
    }
    roots.push(path.join(home, "Games", "World of Warcraft"));
    return roots;
  }
  return [path.join(home, "Games", "world-of-warcraft", "drive_c", "Program Files (x86)", "World of Warcraft")];
}

const KNOWN_FLAVORS: { match: RegExp; label: string; rank: number }[] = [
  { match: /forever/i, label: "WoW: Forever", rank: 0 },
  { match: /^_classic_beta_$/i, label: "Classic beta (possibly Forever beta)", rank: 1 },
  { match: /^_classic_ptr_$/i, label: "Classic PTR", rank: 2 },
  { match: /^_classic_era_$/i, label: "Classic Era", rank: 3 },
  { match: /^_classic_era_ptr_$/i, label: "Classic Era PTR", rank: 4 },
  { match: /^_anniversary_$/i, label: "Anniversary", rank: 5 },
  { match: /^_classic_$/i, label: "Classic (progression)", rank: 6 },
  { match: /^_retail_$/i, label: "Retail", rank: 9 },
  { match: /^_(ptr|xptr|beta)_$/i, label: "Retail test", rank: 9 },
];

export interface LogsCandidate {
  root: string;
  flavor: string;
  label: string;
  clientDir: string;
  logsDir: string;
  hasLogsDir: boolean;
  latestLog: { name: string; mtimeMs: number; size: number } | null;
  rank: number;
}

function flavorInfo(name: string) {
  const known = KNOWN_FLAVORS.find((k) => k.match.test(name));
  return known ?? { label: name.replace(/^_|_$/g, "").replace(/_/g, " "), rank: 7 };
}

function latestLogIn(dir: string): LogsCandidate["latestLog"] {
  let best: LogsCandidate["latestLog"] = null;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!COMBAT_LOG_PATTERN.test(name)) continue;
    try {
      const st = statSync(path.join(dir, name));
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { name, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // Removed while scanning.
    }
  }
  return best;
}

/** Every `_flavor_` folder under the given roots, best guess first: most recent combat log, then known order. */
export function discoverLogsCandidates(roots: string[]): LogsCandidate[] {
  const out: LogsCandidate[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let children: string[] = [];
    try {
      children = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^_.+_$/.test(d.name))
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const flavor of children) {
      const clientDir = path.join(root, flavor);
      if (seen.has(clientDir)) continue;
      seen.add(clientDir);
      const logsDir = path.join(clientDir, "Logs");
      const info = flavorInfo(flavor);
      out.push({
        root,
        flavor,
        label: info.label,
        clientDir,
        logsDir,
        hasLogsDir: existsSync(logsDir),
        latestLog: latestLogIn(logsDir),
        rank: info.rank,
      });
    }
  }
  return out.sort(
    (a, b) =>
      (b.latestLog?.mtimeMs ?? 0) - (a.latestLog?.mtimeMs ?? 0) ||
      Number(b.hasLogsDir) - Number(a.hasLogsDir) ||
      a.rank - b.rank ||
      a.clientDir.localeCompare(b.clientDir),
  );
}

/**
 * The folder to follow: the user's override if set, else the best candidate. Accepts an override pointing at
 * the WoW root or a client folder as well as the Logs folder itself.
 */
export function resolveLogsDir(override: string | null | undefined, candidates: LogsCandidate[]): string | null {
  if (override) {
    if (path.basename(override).toLowerCase() === "logs") return override;
    const inside = path.join(override, "Logs");
    if (existsSync(inside)) return inside;
    const nested = discoverLogsCandidates([override]);
    return nested[0]?.logsDir ?? override;
  }
  return candidates.find((c) => c.hasLogsDir)?.logsDir ?? null;
}
