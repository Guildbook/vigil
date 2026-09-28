import { execFile } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateState } from "../core/protocol";

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Squirrel.Mac only installs updates signed by the same Developer ID as the running app, so ad-hoc signed
 * (unsigned) builds can't update themselves. `TeamIdentifier=not set` marks those.
 */
function macBuildIsSigned(): Promise<boolean> {
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  return new Promise((resolve) => {
    execFile("/usr/bin/codesign", ["-dv", "--verbose=2", bundle], (err, _stdout, stderr) => {
      const team = /^TeamIdentifier=(.+)$/m.exec(String(stderr))?.[1]?.trim();
      resolve(!err && Boolean(team) && team !== "not set");
    });
  });
}

async function canInstallUpdates(): Promise<boolean> {
  if (process.platform === "darwin") return macBuildIsSigned();
  if (process.platform === "linux") return Boolean(process.env.APPIMAGE);
  return process.platform === "win32";
}

/**
 * Checks GitHub Releases shortly after launch and every few hours. Where the app can update itself the update
 * downloads quietly and the window offers a restart; elsewhere (unsigned macOS builds, Linux outside an AppImage)
 * it only says a new version exists and links to the download page. Failures are logged, never shown.
 */
export async function startUpdates(onChange: (state: UpdateState) => void, downloadUrl: string) {
  if (!app.isPackaged) return;
  const install = await canInstallUpdates();
  let offered: string | null = null;
  let ready = false;

  // Errors reach the "error" handler below; the updater's own log would print them a second time.
  autoUpdater.logger = { info: () => {}, warn: console.warn, error: () => {}, debug: () => {} };
  autoUpdater.autoDownload = install;
  autoUpdater.autoInstallOnAppQuit = install;
  autoUpdater.on("update-available", (info) => {
    offered = info.version;
    if (!install) onChange({ state: "available", version: info.version, downloadUrl });
  });
  autoUpdater.on("update-downloaded", (info) => {
    ready = true;
    onChange({ state: "ready", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    console.warn(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    // A download or install that fails still leaves a way to update by hand.
    if (offered && !ready) onChange({ state: "available", version: offered, downloadUrl });
  });

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

export function installUpdate() {
  autoUpdater.quitAndInstall();
}
