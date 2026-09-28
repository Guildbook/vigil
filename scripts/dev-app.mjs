// macOS development only: a copy of Electron.app named Vigil, with its own bundle id and the Vigil icon, for
// `pnpm dev`. macOS names notifications, the menu bar and the Dock after the bundle that runs, so the stock
// Electron.app shows "Electron" and Electron's logo whatever the app sets at runtime. The copy is an APFS clone
// (next to no disk space), rebuilt when Electron or the icon changes, and ad-hoc re-signed after its Info.plist is
// edited. Any failure falls back to the stock Electron.app; VIGIL_STOCK_ELECTRON=1 skips it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** src/core/identity.ts DEV_APP_ID (test/identity.test.ts checks they match). */
export const DEV_BUNDLE_ID = "io.guildbook.vigil.dev";
const NAME = "Vigil";
const REVISION = 1;

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });

/** The executable to run: inside the Vigil copy when it can be made, otherwise the stock one passed in. */
export function devElectron(stockExecutable, pkg) {
  if (process.platform !== "darwin" || process.env.VIGIL_STOCK_ELECTRON) return stockExecutable;
  const stockApp = path.resolve(stockExecutable, "..", "..", "..");
  const work = path.join(pkg, "node_modules", ".cache", "vigil-dev");
  const app = path.join(work, `${NAME}.app`);
  const executable = path.join(app, "Contents", "MacOS", path.basename(stockExecutable));
  const iconSource = path.join(pkg, "build", "icon.icns");
  const stampFile = path.join(work, "stamp");
  try {
    const electronVersion = readFileSync(path.join(stockApp, "Contents", "Info.plist"), "utf8").match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)/)?.[1];
    const iconHash = createHash("sha1").update(readFileSync(iconSource)).digest("hex");
    const stamp = `${REVISION}:${electronVersion}:${iconHash}`;
    if (existsSync(executable) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return executable;

    console.log(`Preparing ${path.relative(pkg, app)} (Electron renamed to ${NAME} for macOS notifications and the Dock)...`);
    rmSync(app, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      run("cp", ["-Rc", stockApp, app]);
    } catch {
      rmSync(app, { recursive: true, force: true });
      run("ditto", [stockApp, app]);
    }
    const plist = path.join(app, "Contents", "Info.plist");
    const iconFile = readFileSync(plist, "utf8").match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)/)?.[1] ?? "electron.icns";
    copyFileSync(iconSource, path.join(app, "Contents", "Resources", iconFile.endsWith(".icns") ? iconFile : `${iconFile}.icns`));
    for (const [key, value] of [
      ["CFBundleName", NAME],
      ["CFBundleDisplayName", NAME],
      ["CFBundleIdentifier", DEV_BUNDLE_ID],
    ]) {
      run("plutil", ["-replace", key, "-string", value, plist]);
    }
    // Editing Info.plist breaks the outer signature; Apple Silicon won't launch it unsigned. Nested frameworks and
    // helpers keep Electron's own signatures.
    run("codesign", ["--force", "--sign", "-", app]);
    try {
      run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app]);
    } catch {
      // Only refreshes the icon cache sooner.
    }
    writeFileSync(stampFile, stamp);
    return executable;
  } catch (err) {
    const detail = err?.stderr ? String(err.stderr).trim() : err instanceof Error ? err.message : String(err);
    console.warn(`Running the stock Electron.app (notifications will say "Electron"): ${detail}`);
    rmSync(app, { recursive: true, force: true });
    return stockExecutable;
  }
}
