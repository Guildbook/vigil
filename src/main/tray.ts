import path from "node:path";
import { app, dialog, Menu, nativeImage, Notification, shell, Tray, type MenuItemConstructorOptions, type NativeImage } from "electron";
import type { AppState } from "../core/protocol";
import { trayMenu, trayStatus, type TrayAction, type TrayTone } from "../core/tray-menu";
import { appIconPath } from "./identity";
import { hasSeen, markSeen } from "./store";
import { checkForUpdatesNow } from "./updates";

export interface TrayDeps {
  state(): AppState;
  showWindow(): void;
  toggleWindow(): void;
  setUploadsPaused(paused: boolean): void;
  openExternal(url: string): void;
  installUpdate(): void;
  quit(): void;
}

/** resources/tray in development, extraResources in packaged builds (outside the asar, where Tray can read it). */
function trayDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "tray") : path.join(app.getAppPath(), "resources", "tray");
}

function iconFile(tone: TrayTone) {
  const suffix = tone === "ok" ? "" : `-${tone}`;
  if (process.platform === "darwin") return `tray${suffix}Template.png`;
  if (process.platform === "win32") return `tray${suffix}.ico`;
  return `tray${suffix}.png`;
}

const WHERE =
  process.platform === "darwin" ? "the menu bar" : process.platform === "win32" ? "the notification area of the taskbar" : "the system tray";

/**
 * The tray (menu bar on macOS) icon: live status, quick actions, and the way back to a closed window. On macOS a
 * click opens the menu, as menu bar items do; on Windows and Linux a click shows or hides the window and the menu
 * is on right click (Linux desktops using AppIndicator always open the menu, which has Open Vigil).
 */
export class VigilTray {
  private readonly tray: Tray;
  private readonly icons = new Map<TrayTone, NativeImage>();
  private tone: TrayTone | null = null;
  private tooltip = "";
  private menuKey = "";
  private noticed = false;

  constructor(private readonly deps: TrayDeps) {
    this.tray = new Tray(this.icon("ok"));
    if (process.platform !== "darwin") this.tray.on("click", () => deps.toggleWindow());
    this.update(deps.state());
  }

  private icon(tone: TrayTone): NativeImage {
    let image = this.icons.get(tone);
    if (!image) {
      image = nativeImage.createFromPath(path.join(trayDir(), iconFile(tone)));
      if (process.platform === "darwin") image.setTemplateImage(true);
      this.icons.set(tone, image);
    }
    return image;
  }

  /** Called on every state broadcast (once a second); only touches the tray when something visible changed. */
  update(state: AppState) {
    const status = trayStatus(state);
    if (status.tone !== this.tone) {
      this.tone = status.tone;
      this.tray.setImage(this.icon(status.tone));
    }
    if (status.tooltip !== this.tooltip) {
      this.tooltip = status.tooltip;
      this.tray.setToolTip(status.tooltip);
    }
    const items = trayMenu(state);
    const key = JSON.stringify(items);
    if (key === this.menuKey) return;
    this.menuKey = key;
    const template: MenuItemConstructorOptions[] = items.map((item) =>
      item.type === "separator"
        ? { type: "separator" }
        : item.type === "info"
          ? { label: item.label, enabled: false }
          : { label: item.label, enabled: item.enabled ?? true, click: () => void this.run(item.action) },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  private async run(action: TrayAction) {
    const state = this.deps.state();
    switch (action) {
      case "open":
        return this.deps.showWindow();
      case "pause":
        return this.deps.setUploadsPaused(true);
      case "resume":
        return this.deps.setUploadsPaused(false);
      case "open-logs":
        if (state.logsDir) void shell.openPath(state.logsDir);
        return;
      case "open-site":
        if (state.server.siteUrl) this.deps.openExternal(state.server.siteUrl);
        return;
      case "check-updates":
        return this.checkForUpdates();
      case "install-update":
        return this.deps.installUpdate();
      case "quit":
        return this.deps.quit();
    }
  }

  private async checkForUpdates() {
    const result = await checkForUpdatesNow();
    // Menu bar apps are not frontmost; without this the dialog can open behind other windows.
    if (process.platform === "darwin") app.focus({ steal: true });
    const box = (message: string, detail: string, buttons = ["OK"]) =>
      dialog.showMessageBox({ type: "info", title: "Vigil updates", message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
    switch (result.kind) {
      case "unsupported":
        return void box("Updates are off in development", "Release builds check GitHub Releases for new versions.");
      case "latest":
        return void box("Vigil is up to date", `You have the latest version, ${result.version}.`);
      case "downloading":
        return void box(`Vigil ${result.version} is downloading`, "Vigil will offer a restart when it is ready.");
      case "ready": {
        const r = await box(`Vigil ${result.version} is ready`, "Restart Vigil to finish updating.", ["Restart now", "Later"]);
        if (r.response === 0) this.deps.installUpdate();
        return;
      }
      case "available": {
        const r = await box(`Vigil ${result.version} is available`, "This build can't update itself. Download the new version to install it.", ["Download", "Later"]);
        if (r.response === 0) this.deps.openExternal(result.downloadUrl);
        return;
      }
      case "error":
        return void box("Couldn't check for updates", result.message);
    }
  }

  /** The first time the window closes into the tray, say so; otherwise Vigil seems to have quit. */
  noticeStillRunning() {
    if (this.noticed || hasSeen("close-to-tray")) return;
    this.noticed = true;
    const title = "Vigil is still running";
    const body = `Vigil keeps following your combat log and uploading fights from ${WHERE}. Quit it from there, or change this in Settings.`;
    if (Notification.isSupported()) {
      // Only remembered once shown: the first notification on macOS may be lost to the permission prompt.
      // macOS shows the bundle's icon beside every notification; elsewhere it has to be passed.
      const notice = new Notification({ title, body, silent: true, ...(process.platform === "darwin" ? {} : { icon: appIconPath() }) });
      notice.on("show", () => markSeen("close-to-tray"));
      notice.show();
    } else if (process.platform === "win32") {
      this.tray.displayBalloon({ title, content: body, iconType: "info" });
      markSeen("close-to-tray");
    }
  }

  destroy() {
    this.tray.destroy();
  }
}

/** A tray can't be created on some Linux desktops; Vigil then behaves as a plain windowed app. */
export function createTray(deps: TrayDeps): VigilTray | null {
  try {
    return new VigilTray(deps);
  } catch (err) {
    console.warn(`No tray icon: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
