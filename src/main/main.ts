import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from "electron";
import { MEDIA_SCHEME, MediaCache, parseMediaUrl, SpellIcons, upstreamUrls } from "../core/media";
import { canOpenExternally } from "../core/origins";
import type { AppState, Settings } from "../core/protocol";
import { APP_NAME } from "../core/identity";
import { Companion } from "./companion";
import { appIconPath, applyIdentity, applyIdentityWhenReady } from "./identity";
import { applyLoginItem } from "./store";
import { createTray, type VigilTray } from "./tray";
import { installUpdate, startUpdates } from "./updates";

const SCHEME = "vigil-companion";
const SIZES = { full: { width: 480, height: 860, minWidth: 380, minHeight: 520 }, compact: { width: 340, height: 250, minWidth: 280, minHeight: 200 } };

applyIdentity();

protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true } }]);

let win: BrowserWindow | null = null;
let companion: Companion | null = null;
let pendingLink: { code: string } | null = null;
let tray: VigilTray | null = null;
/** Set once a real quit starts (tray, app menu, Cmd+Q, update install); until then closing only hides the window. */
let quitting = false;
let lastBlur = 0;

function send(state: AppState) {
  if (win && !win.isDestroyed()) win.webContents.send("state", state);
  tray?.update(state);
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    if (companion) createWindow(companion.settings);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  win.focus();
}

/** A tray click takes focus from the window before it arrives, so "focused" means focused a moment ago. */
function toggleWindow() {
  const focused = win && !win.isDestroyed() && win.isVisible() && (win.isFocused() || Date.now() - lastBlur < 300);
  if (focused) win!.hide();
  else showWindow();
}

function quitApp() {
  quitting = true;
  app.quit();
}

/** quitAndInstall closes the windows before `before-quit` fires, so the close-to-tray handler must stand down first. */
function installAndRestart() {
  quitting = true;
  installUpdate();
}

/** `vigil-companion://pair?code=...`. Any site named in the link is ignored: pairing always asks the home server. */
function parsePairLink(url: string | undefined) {
  if (!url?.startsWith(`${SCHEME}://`)) return null;
  try {
    const code = new URL(url).searchParams.get("code")?.trim().slice(0, 32);
    return code ? { code } : null;
  } catch {
    return null;
  }
}

function openExternal(url: string) {
  if (companion && canOpenExternally(url, companion.trust, companion.pairedSite)) void shell.openExternal(url);
}

/**
 * `vigil-media://` serves Blizzard's spell icons and boss portraits to the window from a disk cache, fetching
 * from the render CDN in the main process (see src/core/media.ts). Unknown or unreachable art gets the fallback.
 */
function serveMedia() {
  const icons = new SpellIcons();
  const cache = new MediaCache({ dir: path.join(app.getPath("userData"), "media-cache"), fetch });
  cache.prune();
  const fallback = readFileSync(path.join(__dirname, "renderer", "icons", "fallback.svg"));
  const headers = (type: string) => ({ "content-type": type, "cache-control": "max-age=86400" });
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const req = parseMediaUrl(request.url, icons);
    let body: Buffer | null = null;
    for (const upstream of req ? upstreamUrls(req) : []) {
      body = await cache.get(upstream);
      if (body) break;
    }
    return body ? new Response(new Uint8Array(body), { headers: headers("image/jpeg") }) : new Response(new Uint8Array(fallback), { headers: headers("image/svg+xml") });
  });
}

/** A pairing link only fills in the form; the player still presses Pair. */
function handleLink(url: string | undefined) {
  const link = parsePairLink(url);
  if (!link) return;
  pendingLink = link;
  if (win && !win.isDestroyed()) {
    win.webContents.send("pair-link", link);
    showWindow();
  }
}

function applyWindowSettings(settings: Settings) {
  if (!win) return;
  win.setAlwaysOnTop(settings.alwaysOnTop, "floating");
  const size = SIZES[settings.mode];
  win.setMinimumSize(size.minWidth, size.minHeight);
  const [w, h] = win.getSize();
  if (settings.mode === "compact" ? w > 420 || h > 360 : h < 520) win.setSize(size.width, size.height);
}

function createWindow(settings: Settings) {
  const size = SIZES[settings.mode];
  win = new BrowserWindow({
    ...size,
    title: APP_NAME,
    ...(process.platform === "darwin" ? {} : { icon: appIconPath() }),
    backgroundColor: "#0b0908",
    alwaysOnTop: settings.alwaysOnTop,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The window is a local page; links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("did-finish-load", () => {
    if (pendingLink) win?.webContents.send("pair-link", pendingLink);
  });
  void win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => (win = null));
  win.on("blur", () => (lastBlur = Date.now()));
  // Windows logoff and shutdown close windows without a quit; let them.
  win.on("session-end", () => (quitting = true));
  // Closing keeps Vigil in the tray, still following the log and uploading, unless the player turned that off.
  win.on("close", (e) => {
    if (quitting || !tray || !companion?.settings.keepInTray) return;
    e.preventDefault();
    win?.hide();
    tray.noticeStillRunning();
  });

  if (!app.isPackaged && process.env.VIGIL_DEV) {
    watch(path.join(__dirname, "renderer"), { persistent: false }, () => win?.webContents.reloadIgnoringCache());
  }
  // Development only: save the window as PNGs at an interval (docs screenshots, visual checks).
  const captureDir = process.env.VIGIL_CAPTURE_DIR;
  if (!app.isPackaged && captureDir) {
    mkdirSync(captureDir, { recursive: true });
    const timer = setInterval(async () => {
      if (!win || win.isDestroyed()) return clearInterval(timer);
      const image = await win.webContents.capturePage();
      writeFileSync(path.join(captureDir, `companion-${Date.now()}.png`), image.toPNG());
    }, Number(process.env.VIGIL_CAPTURE_EVERY_MS ?? 5000));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching Vigil again brings back the window, which may be closed into the tray.
  app.on("second-instance", (_e, argv) => {
    showWindow();
    handleLink(argv.find((a) => a.startsWith(`${SCHEME}://`)));
  });
  app.on("open-url", (e, url) => {
    e.preventDefault();
    handleLink(url);
  });

  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(SCHEME);
  }

  void app.whenReady().then(() => {
    // The window only ever loads its own files and vigil-media art: no permissions, no network requests from the page.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(file|data|devtools|vigil-media):/.test(details.url) });
    });
    serveMedia();

    applyIdentityWhenReady();
    companion = new Companion(send);
    createWindow(companion.settings);
    tray = createTray({
      state: () => companion!.state(),
      showWindow,
      toggleWindow,
      setUploadsPaused: (paused) => companion?.setUploadsPaused(paused),
      openExternal,
      installUpdate: installAndRestart,
      quit: quitApp,
    });
    companion.start();
    handleLink(process.argv.find((a) => a.startsWith(`${SCHEME}://`)));
    // Development only: pair unattended (scripted demos). Packaged builds always pair through the window.
    if (!app.isPackaged && process.env.VIGIL_PAIR_CODE) {
      void companion.pair(process.env.VIGIL_PAIR_CODE).then((r) => {
        if (!r.ok) console.error(`Pairing failed: ${r.error}`);
      });
    }

    ipcMain.handle("state:get", () => companion!.state());
    ipcMain.handle("settings:update", (_e, partial: Partial<Settings>) => {
      const next = companion!.updateSettings(partial);
      applyWindowSettings(next);
      if (typeof partial?.openAtLogin === "boolean") applyLoginItem(next.openAtLogin);
      return next;
    });
    ipcMain.handle("pair", async (_e, input: { code: string }) => {
      const result = await companion!.pair(String(input?.code ?? "").slice(0, 32));
      if (result.ok) pendingLink = null;
      return result;
    });
    ipcMain.handle("unpair", () => companion!.unpair());
    ipcMain.handle("open-external", (_e, url: string) => openExternal(String(url)));
    ipcMain.handle("update:install", () => installAndRestart());
    ipcMain.handle("pick-folder", async () => {
      const r = await dialog.showOpenDialog(win!, {
        properties: ["openDirectory"],
        title: "Choose the WoW Logs folder (or the World of Warcraft folder)",
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    });
    ipcMain.handle("addon:install", (_e, clientDir: string) => companion!.installAddonTo(String(clientDir)));
    ipcMain.handle("upload:retry", (_e, id: string) => companion!.retryUpload(String(id)));

    void startUpdates((update) => companion?.setUpdate(update), `${companion.trust.homeUrl}/vigil`);

    // Clicking the Dock icon brings back a window that was closed or hidden in the menu bar.
    app.on("activate", () => showWindow());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    quitting = true;
    companion?.stop();
  });
}
