import { fightReportSchema, type FightReport } from "@/lib/vigil/report";
import type { Boss } from "../data/bosses";
import { bossAmong } from "./intel";
import type { Settings, UploadState } from "./protocol";

export interface UploadTarget {
  /** The home server's origin; reports upload there whichever guild site the device belongs to. */
  apiUrl: string;
  token: string;
  guild: string | null;
  visibility: "private" | "officers" | "guild" | null;
}

export interface UploaderDeps {
  fetch: typeof fetch;
  target: () => UploadTarget | null;
  onStatus: (id: string, state: UploadState) => void;
  /** The site no longer accepts this device (revoked, or the member left). */
  onUnauthorized: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

const BACKOFF_MS = [2_000, 5_000, 15_000, 60_000, 120_000];

interface Job {
  id: string;
  report: FightReport;
  attempts: number;
}

/**
 * Uploads fight reports one at a time. Network failures, 5xx and 429 retry with backoff (honouring
 * Retry-After); a 401 or 403 stops, since retrying a revoked token only adds load.
 */
export class Uploader {
  private readonly queue: Job[] = [];
  private busy = false;
  private waiting = false;
  private paused = false;

  constructor(private readonly deps: UploaderDeps) {}

  /** While paused, fights queue up but nothing is sent; an upload already in flight finishes. */
  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) void this.pump();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  enqueue(id: string, report: FightReport) {
    this.queue.push({ id, report, attempts: 0 });
    this.deps.onStatus(id, { state: "queued" });
    void this.pump();
  }

  get pending(): number {
    return this.queue.length;
  }

  private later(ms: number) {
    this.waiting = true;
    (this.deps.setTimer ?? setTimeout)(() => {
      this.waiting = false;
      void this.pump();
    }, ms);
  }

  private async pump() {
    if (this.busy || this.waiting || this.paused) return;
    const job = this.queue[0];
    if (!job) return;
    const target = this.deps.target();
    if (!target) return;
    const invalid = formatProblem(job.report);
    if (invalid) {
      this.queue.shift();
      this.deps.onStatus(job.id, { state: "failed", error: `Not uploaded: ${invalid}. Check for a Vigil update.`, retrying: false, final: true });
      void this.pump();
      return;
    }
    this.busy = true;
    this.deps.onStatus(job.id, { state: "uploading" });
    let retryIn: number | null = null;
    try {
      const res = await this.deps.fetch(`${target.apiUrl.replace(/\/$/, "")}/api/vigil/companion/reports`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
        body: JSON.stringify({ report: job.report, visibility: target.visibility, guild: target.guild }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string; code?: string; warning?: string | null };
      if (res.ok && body.url) {
        this.queue.shift();
        this.deps.onStatus(job.id, { state: "uploaded", url: body.url, ...(body.warning ? { warning: body.warning } : {}) });
      } else if (res.status === 409 && body.code === "version_mismatch") {
        this.queue.shift();
        this.deps.onStatus(job.id, { state: "failed", error: `Not uploaded: ${body.error ?? "this log is from another game than your guild's."}`, retrying: false, final: true });
      } else if (res.status === 401 || res.status === 403) {
        this.queue.shift();
        const error = body.error ?? "The site refused this companion.";
        this.deps.onStatus(job.id, { state: "failed", error, retrying: false });
        this.deps.onUnauthorized(error);
      } else if (res.status === 429 || res.status >= 500) {
        const after = Number(res.headers.get("retry-after"));
        retryIn = this.backoff(job);
        if (retryIn !== null && Number.isFinite(after) && after > 0) retryIn = after * 1000;
        this.deps.onStatus(job.id, { state: "failed", error: body.error ?? `Site error ${res.status}`, retrying: retryIn !== null });
      } else if (res.status === 400) {
        this.queue.shift();
        const detail = body.error?.replace(/\s*Reload and try again\.?$/, "").replace(/\.$/, "");
        const error = `Not uploaded: the site rejected this report${detail ? ` (${detail})` : ""}. Check for a Vigil update.`;
        this.deps.onStatus(job.id, { state: "failed", error, retrying: false, final: true });
      } else {
        this.queue.shift();
        this.deps.onStatus(job.id, { state: "failed", error: body.error ?? `Upload refused (${res.status})`, retrying: false });
      }
    } catch (err) {
      retryIn = this.backoff(job);
      const error = err instanceof Error ? `Could not reach the site: ${err.message}` : "Could not reach the site.";
      this.deps.onStatus(job.id, { state: "failed", error, retrying: retryIn !== null });
    } finally {
      this.busy = false;
    }
    if (retryIn === null) void this.pump();
    else this.later(retryIn);
  }

  private backoff(job: Job): number | null {
    const ms = BACKOFF_MS[job.attempts++];
    if (ms === undefined) {
      this.queue.shift();
      return null;
    }
    return ms;
  }
}

/** Why the site's report schema would refuse this report (the first field at fault), or null. */
export function formatProblem(report: FightReport): string | null {
  const parsed = fightReportSchema.safeParse(report);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return `this report failed the site's format check${issue ? ` (${issue.path.join(".") || "report"}: ${issue.message})` : ""}`;
}

/**
 * The report as a boss fight when the log had no ENCOUNTER_START but a known boss was among the targets (Classic
 * Era dungeons never log encounters). It gets the boss's name and the client's DungeonEncounter ID, so the site
 * files it with that boss, and success when the boss died. A boss without an encounter ID (a rare elite) is only
 * relabelled. Other reports come back unchanged.
 */
export function asBossFight(report: FightReport): FightReport {
  if (report.fight.kind === "boss") return report;
  const boss = bossAmong(report.fight.targets);
  if (!boss) return report;
  const died = report.fight.targets.some((t) => t.died && isBossTarget(boss, t));
  return {
    ...report,
    fight: {
      ...report.fight,
      kind: "boss",
      label: boss.name,
      ...(boss.encounterId === null ? {} : { encounter: { id: boss.encounterId, name: boss.name, ...(died ? { success: true } : {}) } }),
    },
  };
}

function isBossTarget(boss: Boss, t: { npcId: number | null; name: string }) {
  if (t.npcId !== null && boss.npcIds.includes(t.npcId)) return true;
  return boss.unitNames.some((n) => n.toLowerCase() === t.name.toLowerCase());
}

/** Why a finished fight should not be uploaded, or null to upload it. Boss kills and wipes always upload. */
export function skipReason(
  report: FightReport,
  settings: Pick<Settings, "autoUpload" | "minFightSeconds">,
  paired: boolean,
): string | null {
  if (!settings.autoUpload) return "Auto-upload is off";
  if (!paired) return "Not paired with the site";
  const boss = report.fight.kind === "boss" || bossAmong(report.fight.targets) !== null;
  if (!boss && report.fight.durationMs < settings.minFightSeconds * 1000) {
    return `Shorter than ${settings.minFightSeconds} s`;
  }
  return null;
}
