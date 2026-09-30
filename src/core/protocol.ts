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

/** Where a fight uploads: the guild picked for its log's game, and why when that was a fallback. */
export interface UploadDestination {
  pairingId: string;
  guild: string;
  gameVersion: LogGameVersion | null;
  warning: string | null;
}

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
  destination: UploadDestination | null;
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

/** One paired guild, as the window and tray show it. */
export interface PairedGuild {
  id: string;
  /** `gameVersion` comes from the pairing or the site's profile; null until either has said. */
  guild: { slug: string; name: string; gameVersion: LogGameVersion | null };
  user: { name: string | null } | null;
  device: { id: string; name: string };
  siteUrl: string | null;
  pairedAt: string;
  lastUsedAt: string | null;
  error: string | null;
}

export interface PairingState {
  paired: boolean;
  /** At most one per game version. */
  pairings: PairedGuild[];
  /** From the default guild's profile (the most recently used). */
  defaultVisibility: "private" | "officers" | "guild" | null;
  /** Where the device tokens live: the OS keychain via Electron safeStorage, or memory only. */
  storage: "keychain" | "memory" | null;
  /** The first problem with a paired guild, named when there are several. */
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
  /** Where API calls go, and the default paired guild's own site (the one that took the latest upload). */
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

export interface PairResult {
  ok: boolean;
  error?: string;
  guild?: { name: string; gameVersion: LogGameVersion | null };
  /** Guilds this pairing replaced on this computer (same game version, or the same guild paired again). */
  replaced?: { name: string; gameVersion: LogGameVersion | null }[];
}

export interface CompanionBridge {
  getState(): Promise<AppState>;
  onState(cb: (state: AppState) => void): () => void;
  updateSettings(partial: Partial<Settings>): Promise<Settings>;
  pair(input: { code: string }): Promise<PairResult>;
  /** One guild by pairing id, or every guild without one. */
  unpair(pairingId?: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  installAddon(clientDir: string): Promise<{ ok: boolean; message: string }>;
  retryUpload(fightId: string): Promise<void>;
  onPairLink(cb: (link: { code: string }) => void): () => void;
  installUpdate(): Promise<void>;
}
