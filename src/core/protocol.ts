import type { Faction, WowClass } from "@/lib/game";
import type { LogGameVersion } from "@/lib/vigil/game-version";
import type { Callout } from "@/lib/vigil/live";
import type { EngineSnapshot } from "./engine";
import type { GroupFightView } from "./group";

/** Types shared by the main process and the window, across the preload bridge. */

export type VisibilityChoice = "default" | "private" | "officers" | "guild";

export interface Settings {
  /** Logs folder (or WoW root, or client folder) chosen by the player; null follows auto-detection. */
  logsDirOverride: string | null;
  autoUpload: boolean;
  /** Trash pulls shorter than this are not uploaded. Boss encounters always are. */
  minFightSeconds: number;
  /** "default" uses the member's default from the site (private unless they changed it). */
  visibility: VisibilityChoice;
  alwaysOnTop: boolean;
  mode: "full" | "compact";
  /** "auto" picks the rotation model from the spells cast, as the upload page does. */
  modelId: string;
  /** Closing the window leaves Vigil in the tray (menu bar on macOS), still following the log and uploading. */
  keepInTray: boolean;
  /** Launch at login (macOS and Windows only; see AppState.canOpenAtLogin). */
  openAtLogin: boolean;
}

export type UploadState =
  | { state: "queued" }
  | { state: "uploading" }
  | { state: "uploaded"; url: string; /** Kept despite a problem the player should know about (a log from another game). */ warning?: string }
  | { state: "skipped"; reason: string }
  | { state: "failed"; error: string; retrying: boolean; /** Sending the same report again cannot help. */ final?: boolean };

export interface FightSummary {
  id: string;
  label: string;
  kind: "boss" | "trash";
  startedAt: string;
  durationMs: number;
  score: number;
  modelLabel: string | null;
  metric: "damage" | "threat" | "healing";
  perSecond: number;
  gcdUsage: number;
  callouts: string[];
  upload: UploadState;
  encounterId: number | null;
  /** The group fight (meters, deaths, boss abilities) recorded alongside, when one lines up. */
  groupId: string | null;
}

/** The recording player, for the header. Class comes from the site, the rotation model or the spells cast. */
export interface Identity {
  name: string;
  level: number | null;
  wowClass: WowClass | null;
  faction: Faction | null;
}

export interface PairingState {
  paired: boolean;
  /** `gameVersion` comes from the site's profile, so it is missing until that has loaded. */
  guild: { slug: string; name: string; gameVersion?: LogGameVersion } | null;
  user: { name: string | null } | null;
  device: { id: string; name: string } | null;
  defaultVisibility: "private" | "officers" | "guild" | null;
  /** Where the device token lives: the OS keychain via Electron safeStorage, or memory only. */
  storage: "keychain" | "memory" | null;
  error: string | null;
}

export interface LogsOption {
  label: string;
  logsDir: string;
  latestLog: string | null;
  latestAt: number | null;
}

export interface AddonTarget {
  label: string;
  clientDir: string;
  installed: string | null;
}

/** Auto-update progress. "available" is shown when the update can't install itself (unsigned macOS builds). */
export type UpdateState =
  | { state: "idle" }
  | { state: "ready"; version: string }
  | { state: "available"; version: string; downloadUrl: string };

export interface AppState {
  version: string;
  /** Where API calls go, and the paired guild's own site (for links). */
  server: { homeUrl: string; siteUrl: string | null; dev: boolean };
  update: UpdateState;
  engine: EngineSnapshot | null;
  logsDir: string | null;
  logsOptions: LogsOption[];
  callouts: Callout[];
  fights: FightSummary[];
  /** Finished group fights, newest first. */
  groupFights: GroupFightView[];
  identity: Identity | null;
  settings: Settings;
  /** Paused from the tray for this session; queued fights wait and upload on resume. */
  uploadsPaused: boolean;
  /** Whether "Start Vigil when I log in" applies: packaged macOS and Windows builds. */
  canOpenAtLogin: boolean;
  pairing: PairingState;
  addon: { bundled: string | null; targets: AddonTarget[] };
  models: { id: string; label: string }[];
}

export interface CompanionBridge {
  getState(): Promise<AppState>;
  onState(cb: (state: AppState) => void): () => void;
  updateSettings(partial: Partial<Settings>): Promise<Settings>;
  pair(input: { code: string }): Promise<{ ok: boolean; error?: string }>;
  unpair(): Promise<void>;
  openExternal(url: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  installAddon(clientDir: string): Promise<{ ok: boolean; message: string }>;
  retryUpload(fightId: string): Promise<void>;
  onPairLink(cb: (link: { code: string }) => void): () => void;
  installUpdate(): Promise<void>;
}
