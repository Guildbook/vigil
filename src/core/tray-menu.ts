import { APP_NAME } from "./identity";
import type { AppState } from "./protocol";

/** What the tray says and offers, derived from the app state alone so it can be tested without Electron. */

export type TrayTone = "ok" | "paused" | "attention";

export type TrayAction = "open" | "pause" | "resume" | "open-logs" | "open-site" | "check-updates" | "install-update" | "quit";

export type TrayItem =
  | { type: "separator" }
  | { type: "info"; label: string }
  | { type: "action"; action: TrayAction; label: string; enabled?: boolean; /** For "open-site": which guild's site. */ url?: string };

export interface TrayStatus {
  /** The combat log: watching, waiting or what is wrong. */
  status: string;
  /** The paired guilds (named, or counted past two), or that there is none. */
  guild: string;
  /** Uploads in flight, paused, or a problem with the site; null when there is nothing to say. */
  uploads: string | null;
  tone: TrayTone;
  tooltip: string;
}

type TrayState = Pick<AppState, "logsDir" | "logsOptions" | "engine" | "pairing" | "fights" | "server" | "update" | "uploadsPaused">;

const MAX_LINE = 60;

const clip = (s: string) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 3).trimEnd()}...` : s);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Classic Era (_classic_era_)" to "Classic Era": the options carry the folder name for the settings list. */
function clientName(s: TrayState): string | null {
  const option = s.logsOptions.find((o) => o.logsDir === s.logsDir);
  return option ? option.label.replace(/\s*\([^()]*\)$/, "") : null;
}

function logStatus(s: TrayState): { text: string; ok: boolean } {
  if (!s.logsDir) return { text: "No Logs folder found", ok: false };
  if (!s.engine) return { text: "Logs folder is missing", ok: false };
  if (s.engine.status.error) return { text: "Can't read the combat log", ok: false };
  if (!s.engine.status.file) return { text: "Waiting for a combat log", ok: true };
  const client = clientName(s);
  return { text: client ? `Watching ${client} log` : "Watching the combat log", ok: true };
}

function guildLine(s: TrayState): string {
  const names = s.pairing.paired ? s.pairing.pairings.map((g) => g.guild.name) : [];
  if (names.length === 0) return "Not paired with a guild";
  if (names.length > 2) return `Paired with ${names.length} guilds`;
  return clip(`Paired with ${names.join(" and ")}`);
}

export function trayStatus(s: TrayState): TrayStatus {
  const log = logStatus(s);
  const p = s.pairing;
  const guild = guildLine(s);
  const pending = s.fights.filter((f) => f.upload.state === "queued" || f.upload.state === "uploading" || (f.upload.state === "failed" && f.upload.retrying)).length;
  let uploads: string | null = null;
  if (p.paired && p.error) uploads = clip(p.error);
  else if (p.paired && s.uploadsPaused) uploads = pending ? `Uploads paused, ${plural(pending, "fight")} waiting` : "Uploads paused";
  else if (p.paired && pending) uploads = `Uploading ${plural(pending, "fight")}`;

  const tone: TrayTone = !log.ok || (p.paired && p.error) ? "attention" : p.paired && s.uploadsPaused ? "paused" : "ok";
  const tooltip = [APP_NAME, log.text, guild, uploads].filter(Boolean).join("\n");
  return { status: log.text, guild, uploads, tone, tooltip };
}

export function trayMenu(s: TrayState): TrayItem[] {
  const status = trayStatus(s);
  const items: TrayItem[] = [{ type: "info", label: status.status }, { type: "info", label: status.guild }];
  if (status.uploads) items.push({ type: "info", label: status.uploads });
  items.push({ type: "separator" }, { type: "action", action: "open", label: "Open Vigil" });
  if (s.pairing.paired) {
    items.push(s.uploadsPaused ? { type: "action", action: "resume", label: "Resume uploads" } : { type: "action", action: "pause", label: "Pause uploads" });
  }
  items.push({ type: "action", action: "open-logs", label: "Open Logs folder", enabled: Boolean(s.logsDir && s.engine) });
  const sites = s.pairing.paired ? s.pairing.pairings.filter((g) => g.siteUrl) : [];
  if (sites.length > 1) {
    for (const g of sites) items.push({ type: "action", action: "open-site", label: clip(`Open ${g.guild.name} site`), url: g.siteUrl! });
  } else {
    const url = sites[0]?.siteUrl ?? (s.pairing.paired ? s.server.siteUrl : null);
    items.push({ type: "action", action: "open-site", label: "Open guild site", enabled: Boolean(url), ...(url ? { url } : {}) });
  }
  items.push(
    { type: "separator" },
    s.update.state === "ready"
      ? { type: "action", action: "install-update", label: `Restart to update to ${APP_NAME} ${s.update.version}` }
      : { type: "action", action: "check-updates", label: "Check for updates..." },
    { type: "action", action: "quit", label: "Quit Vigil" },
  );
  return items;
}
