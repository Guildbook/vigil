import type { Callout } from "@/lib/vigil/live";
import type { EngineSnapshot } from "./engine";

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
}

export type UploadState =
  | { state: "queued" }
  | { state: "uploading" }
  | { state: "uploaded"; url: string }
  | { state: "skipped"; reason: string }
  | { state: "failed"; error: string; retrying: boolean };

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
}

export interface PairingState {
  paired: boolean;
  guild: { slug: string; name: string } | null;
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
  settings: Settings;
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
