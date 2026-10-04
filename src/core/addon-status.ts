/**
 * How Settings describes the in-game addon in one client folder. The addon is versioned on its own, separate
 * from the desktop app, so every string names it as "v" plus the addon's TOC version. No Node imports: the
 * renderer uses this.
 */

export type AddonAction = "install" | "update" | "reinstall" | null;

export interface AddonStatus {
  text: string;
  action: AddonAction;
}

/** Same comparison as core/addon.ts compareSemver, kept here so the renderer bundle stays free of node:fs. */
function compare(a: string, b: string): number {
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

export function addonStatus(installed: string | null, bundled: string | null): AddonStatus {
  if (!installed) return { text: "Not installed", action: bundled ? "install" : null };
  if (!bundled) return { text: `v${installed} installed`, action: null };
  const d = compare(installed, bundled);
  if (d < 0) return { text: `v${installed} installed, v${bundled} available`, action: "update" };
  if (d > 0) return { text: `v${installed} installed, newer than the bundled v${bundled}`, action: null };
  return { text: `v${installed}, up to date`, action: "reinstall" };
}

export interface AddonPrompt {
  label: string;
  clientDir: string;
  action: "install" | "update";
  installed: string | null;
  bundled: string;
  /** Stored in Settings.addonPromptDismissed by Not now; a newer bundled addon asks again. */
  dismissKey: string;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * The prompt on the Live view for the client whose log Vigil follows (the best-guess client when none is
 * followed yet), so nobody has to find the addon in Settings. Null when it is installed and current, the build
 * has no addon, or the player said Not now to this version.
 */
export function addonPrompt(
  targets: { label: string; clientDir: string; installed: string | null }[],
  bundled: string | null,
  logsDir: string | null,
  dismissed: string[],
): AddonPrompt | null {
  if (!bundled || !targets.length) return null;
  const followed = logsDir ? norm(logsDir) : null;
  const target = (followed && targets.find((t) => followed.startsWith(`${norm(t.clientDir)}/`))) || targets[0]!;
  const { action } = addonStatus(target.installed, bundled);
  if (action !== "install" && action !== "update") return null;
  const dismissKey = `${target.clientDir}@${bundled}`;
  if (dismissed.includes(dismissKey)) return null;
  return { label: target.label, clientDir: target.clientDir, action, installed: target.installed, bundled, dismissKey };
}

export const ADDON_ACTION_LABEL: Record<Exclude<AddonAction, null>, string> = {
  install: "Install",
  update: "Update",
  reinstall: "Reinstall",
};
