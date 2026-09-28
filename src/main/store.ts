import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { trustedSiteOrigin, validHomeUrl, type TrustConfig } from "../core/origins";
import type { Settings } from "../core/protocol";

/** Set by scripts/build.mjs: the home server for release builds, already validated as a public HTTPS origin. */
declare const __HOME_URL__: string;

const DEV_HOME_URL = "http://localhost:3000";

/**
 * The server every API call goes to. Release builds use the one baked in at build time and ignore the
 * environment; development builds default to the local dev server and accept `VIGIL_SITE_URL`.
 */
export function trustConfig(): TrustConfig {
  if (app.isPackaged) return { homeUrl: __HOME_URL__, allowLocal: false };
  const override = process.env.VIGIL_SITE_URL ? validHomeUrl(process.env.VIGIL_SITE_URL, true) : null;
  return { homeUrl: override ?? DEV_HOME_URL, allowLocal: true };
}

export const DEFAULT_SETTINGS = (): Settings => ({
  logsDirOverride: null,
  autoUpload: true,
  minFightSeconds: 20,
  visibility: "default",
  alwaysOnTop: false,
  mode: "full",
  modelId: "auto",
  keepInTray: true,
  openAtLogin: false,
});

const file = (name: string) => path.join(app.getPath("userData"), name);

function readJson<T>(name: string): Partial<T> | null {
  try {
    return JSON.parse(readFileSync(file(name), "utf8")) as Partial<T>;
  } catch {
    return null;
  }
}

function writeJson(name: string, value: unknown) {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(file(name), JSON.stringify(value, null, 2));
}

export function loadSettings(): Settings {
  const defaults = DEFAULT_SETTINGS();
  const saved = readJson<Settings>("settings.json") ?? {};
  // Only known keys: older versions also stored the site address here.
  const known = Object.fromEntries(Object.entries(saved).filter(([k]) => k in defaults));
  const settings = { ...defaults, ...known };
  // The system owns the login item (the player can remove it in System Settings or Task Manager).
  if (loginItemsSupported()) settings.openAtLogin = app.getLoginItemSettings().openAtLogin;
  return settings;
}

export function saveSettings(settings: Settings) {
  writeJson("settings.json", settings);
}

/**
 * Login items need a stable app path: packaged macOS and Windows builds. A development run would register the
 * bare Electron binary, and an AppImage moves whenever it is updated.
 */
export function loginItemsSupported(): boolean {
  return app.isPackaged && (process.platform === "darwin" || process.platform === "win32");
}

export function applyLoginItem(openAtLogin: boolean) {
  if (loginItemsSupported()) app.setLoginItemSettings({ openAtLogin });
}

/** One-time hints the player has already seen (not settings: nothing to change in the window). */
export function hasSeen(hint: string): boolean {
  return readJson<Record<string, boolean>>("seen.json")?.[hint] === true;
}

export function markSeen(hint: string) {
  writeJson("seen.json", { ...readJson<Record<string, boolean>>("seen.json"), [hint]: true });
}

export interface PairingRecord {
  /** The guild's own site as the home server named it, for links. API calls always go to the home server. */
  siteUrl: string | null;
  guild: { slug: string; name: string };
  device: { id: string; name: string };
}

export function loadPairing(config: TrustConfig): PairingRecord | null {
  const p = readJson<PairingRecord>("pairing.json");
  if (!p?.guild || !p.device) return null;
  return { guild: p.guild, device: p.device, siteUrl: trustedSiteOrigin(p.siteUrl, config, { vouched: true }) };
}

export function savePairing(p: PairingRecord | null) {
  if (p) writeJson("pairing.json", p);
  else rmSync(file("pairing.json"), { force: true });
}

/**
 * The device token, encrypted with Electron safeStorage (Keychain on macOS, DPAPI on Windows, the secret
 * service on Linux). Without OS encryption the token stays in memory for this run and is never written.
 */
export class TokenStore {
  private memory: string | null = null;
  private read = false;

  get storage(): "keychain" | "memory" {
    return safeStorage.isEncryptionAvailable() ? "keychain" : "memory";
  }

  load(): string | null {
    if (this.memory || this.read) return this.memory;
    this.read = true;
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      this.memory = safeStorage.decryptString(readFileSync(file("device-token.bin")));
      return this.memory;
    } catch {
      return null;
    }
  }

  save(token: string) {
    this.memory = token;
    if (!safeStorage.isEncryptionAvailable()) return;
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(file("device-token.bin"), safeStorage.encryptString(token), { mode: 0o600 });
  }

  clear() {
    this.memory = null;
    rmSync(file("device-token.bin"), { force: true });
  }
}
