import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ID, APP_NAME, COPYRIGHT, DEV_APP_ID, LEGACY_NAME, WEBSITE } from "../src/core/identity";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;
const config = createRequire(__filename)(path.join(root, "electron-builder.config.cjs")) as {
  appId: string;
  productName: string;
  copyright: string;
  extraResources: { from: string; to: string }[];
  mac: { icon: string };
  win: { icon: string };
  nsis: Record<string, unknown>;
  linux: { icon: string; executableName: string; syncDesktopName: boolean; desktop: { entry: Record<string, string> } };
};

describe("app identity", () => {
  it("names the app Vigil in package.json, electron-builder and at runtime", () => {
    expect(APP_NAME).toBe("Vigil");
    expect(pkg.productName).toBe(APP_NAME);
    expect(config.productName).toBe(APP_NAME);
    expect(config.nsis.shortcutName).toBe(APP_NAME);
    expect(config.nsis.uninstallDisplayName).toBe(APP_NAME);
    expect(config.linux.desktop.entry.Name).toBe(APP_NAME);
    expect(read("src/renderer/index.html")).toContain(`<title>${APP_NAME}</title>`);
  });

  it("uses one app id for the bundle, the installer's shortcut and the runtime AppUserModelID", () => {
    expect(config.appId).toBe(APP_ID);
    expect(DEV_APP_ID).toBe(`${APP_ID}.dev`);
    expect(read("scripts/dev-app.mjs")).toContain(`DEV_BUNDLE_ID = "${DEV_APP_ID}"`);
    const identity = read("src/main/identity.ts");
    expect(identity).toMatch(/app\.setAppUserModelId\(APP_ID\)/);
    expect(identity).toMatch(/app\.once\("will-finish-launching", \(\) => app\.setName\(APP_NAME\)\)/);
    expect(identity).toMatch(/applicationName: APP_NAME/);
  });

  it("keeps the settings folder and safeStorage key under the name 0.1.0 used", () => {
    expect(LEGACY_NAME).toBe(pkg.name);
    const identity = read("src/main/identity.ts");
    expect(identity).toMatch(/app\.setName\(LEGACY_NAME\)/);
    expect(identity).toMatch(/path\.join\(app\.getPath\("appData"\), LEGACY_NAME\)/);
  });

  it("matches the Linux desktop entry to the window class Electron takes from desktopName", () => {
    expect(pkg.desktopName).toBe(`${config.linux.executableName}.desktop`);
    expect(config.linux.syncDesktopName).toBe(true);
    expect(config.linux.desktop.entry.StartupWMClass).toBe(config.linux.executableName);
  });

  it("agrees on copyright and website", () => {
    expect(config.copyright).toBe(COPYRIGHT);
    expect(pkg.homepage).toBe(WEBSITE);
  });

  it("builds every platform's icons from the Vigil icon and ships the PNG the app loads", () => {
    expect(config.mac.icon).toBe("build/icon-mac.png");
    expect(config.win.icon).toBe("build/icon.ico");
    for (const key of ["installerIcon", "uninstallerIcon", "installerHeaderIcon"]) expect(config.nsis[key]).toBe("build/icon.ico");
    expect(config.linux.icon).toBe("build/icon.png");
    expect(config.extraResources).toContainEqual({ from: "build/icon.png", to: "icon.png" });
  });
});
