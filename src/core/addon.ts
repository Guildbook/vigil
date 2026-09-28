import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Installing the Vigil addon into a client's AddOns folder. Ported from the AzerothOS importer: the same
 * TOC-version comparison, and a source picker that never lets a stale bundled copy replace a newer one.
 */

export const ADDON_FOLDER = "Vigil";
export const ADDON_TOC = "Vigil.toc";

export const addonDestDir = (clientDir: string) => path.join(clientDir, "Interface", "AddOns", ADDON_FOLDER);

export function readTocVersion(tocPath: string): string | null {
  try {
    const m = readFileSync(tocPath, "utf8").match(/^##\s*Version:\s*([^\r\n]+)/im);
    return m ? m[1]!.trim() : null;
  } catch {
    return null;
  }
}

/** Installed version, or null when the TOC is missing (an empty leftover folder does not count). */
export function installedVersion(clientDir: string): string | null {
  const toc = path.join(addonDestDir(clientDir), ADDON_TOC);
  return existsSync(toc) ? (readTocVersion(toc) ?? "0.0.0") : null;
}

export function compareSemver(a: string, b: string): number {
  const parts = (v: string) =>
    String(v || "0")
      .split(/[^\d]+/)
      .filter(Boolean)
      .map((x) => parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The highest-versioned addon folder among `candidates`; on a tie, the repo copy beats a bundled one. */
export function pickAddonSource(candidates: string[]): { path: string; version: string } | null {
  const found = candidates
    .filter((c) => existsSync(path.join(c, ADDON_TOC)))
    .map((c) => ({ path: c, version: readTocVersion(path.join(c, ADDON_TOC)) ?? "0.0.0" }));
  found.sort((a, b) => {
    const byVersion = compareSemver(b.version, a.version);
    if (byVersion) return byVersion;
    const score = (p: string) => (p.includes(`${path.sep}resources${path.sep}`) ? 0 : 1);
    return score(b.path) - score(a.path);
  });
  return found[0] ?? null;
}

/** Replaces `Interface/AddOns/Vigil` in the client folder with the source copy. */
export function installAddon(sourceDir: string, clientDir: string) {
  if (!existsSync(clientDir)) throw new Error("That client folder does not exist.");
  if (!existsSync(path.join(sourceDir, ADDON_TOC))) throw new Error("The bundled Vigil addon is missing.");
  const dest = addonDestDir(clientDir);
  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(sourceDir, dest, { recursive: true });
  return { dest, version: readTocVersion(path.join(dest, ADDON_TOC)) ?? "unknown" };
}
