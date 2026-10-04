import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { trustedSiteOrigin, validHomeUrl, type TrustConfig } from "../core/origins";
import { loadPairingsFrom, type LegacyPairing, type Pairing, type PairingsFile } from "../core/pairings";
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
  addonPromptDismissed: [],
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

/**
 * The paired guilds, from `pairings.json`. A 0.4.0 install has a single `pairing.json` instead: it becomes the
 * first entry (its token stays in `device-token.bin`), `pairings.json` is written and the old file removed.
 */
export function loadPairings(config: TrustConfig): Pairing[] {
  const saved = readJson<PairingsFile>("pairings.json");
  const legacy = saved ? null : readJson<LegacyPairing>("pairing.json");
  const { pairings, migrated } = loadPairingsFrom(saved, legacy, new Date());
  const trusted = pairings.map((p) => ({ ...p, siteUrl: trustedSiteOrigin(p.siteUrl, config, { vouched: true }) }));
  if (migrated) {
    try {
      savePairings(trusted);
      rmSync(file("pairing.json"), { force: true });
    } catch {
      // Read again from pairing.json next time.
    }
  }
  return trusted;
}

export function savePairings(pairings: readonly Pairing[]) {
  const data: PairingsFile = { version: 2, pairings: [...pairings] };
  writeJson("pairings.json", data);
}

/**
 * Device tokens, one file per pairing, each encrypted with Electron safeStorage (Keychain on macOS, DPAPI on
 * Windows, the secret service on Linux). Without OS encryption tokens stay in memory for this run and are never
 * written.
 */
export class TokenStore {
  private readonly memory = new Map<string, string | null>();

  get storage(): "keychain" | "memory" {
    return safeStorage.isEncryptionAvailable() ? "keychain" : "memory";
  }

  load(tokenFile: string): string | null {
    if (this.memory.has(tokenFile)) return this.memory.get(tokenFile) ?? null;
    let token: string | null = null;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        token = safeStorage.decryptString(readFileSync(file(tokenFile)));
      } catch {
        token = null;
      }
    }
    this.memory.set(tokenFile, token);
    return token;
  }

  save(tokenFile: string, token: string) {
    this.memory.set(tokenFile, token);
    if (!safeStorage.isEncryptionAvailable()) return;
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(file(tokenFile), safeStorage.encryptString(token), { mode: 0o600 });
  }

  clear(tokenFile: string) {
    this.memory.delete(tokenFile);
    rmSync(file(tokenFile), { force: true });
  }
}
