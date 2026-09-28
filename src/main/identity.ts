import path from "node:path";
import { app, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { APP_ID, APP_NAME, COPYRIGHT, LEGACY_NAME, WEBSITE } from "../core/identity";

/**
 * The PNG app icon for windows, notifications and the About panel on Windows and Linux: extraResources in
 * packaged builds, build/ in development. macOS takes its icon from the bundle's .icns instead.
 */
export function appIconPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(app.getAppPath(), "build", "icon.png");
}

/**
 * At startup, before `ready`: the name, where settings live, and on Windows the id notifications and shortcuts share.
 * Electron names the safeStorage key after the app while it starts up, before `will-finish-launching`; the legacy
 * name holds until then so the key stays the one 0.1.0 created, and everything visible (menus, About, windows,
 * notifications) is built afterwards, under the real name.
 */
export function applyIdentity() {
  app.setName(LEGACY_NAME);
  app.once("will-finish-launching", () => app.setName(APP_NAME));
  app.setPath("userData", process.env.VIGIL_USER_DATA || path.join(app.getPath("appData"), LEGACY_NAME));
  // Must equal electron-builder's appId, which the NSIS installer stamps on the Start menu shortcut; toasts from a
  // different id show no name or icon. Development runs have no such shortcut and keep Electron's default.
  if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId(APP_ID);
}

/**
 * After `ready`: Electron's default menu, rebuilt (it is made before the rename, so it would say "About vigil"),
 * the About panel everywhere, and in development the Dock icon (the bundle there is Electron's).
 */
export function applyIdentityWhenReady() {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as const] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: `${APP_NAME} website`, click: () => void shell.openExternal(WEBSITE) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    // macOS would otherwise add the bundle's build number, which in development is Electron's version.
    version: "",
    copyright: COPYRIGHT,
    website: WEBSITE,
    ...(process.platform === "darwin" ? {} : { iconPath: appIconPath() }),
  });
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), "build", "icon-mac.png"));
}
