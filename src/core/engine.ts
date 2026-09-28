import path from "node:path";
import { LiveSession, type Callout, type CompletedFight, type LiveFight, type LiveSessionOptions } from "@/lib/vigil/live";
import { LogTailer, type FileChangeReason } from "./tailer";

/**
 * Log time for "now". The client stamps each line, but a quiet log says nothing about the present, so the
 * clock runs on from the last event by the wall time since it arrived (capped, so a stale log never
 * produces an hour-long fight).
 */
export class LogClock {
  private logT: number | null = null;
  private wallT = 0;

  constructor(private readonly wall: () => number = Date.now) {}

  seen(logT: number | null) {
    if (logT === null || logT === this.logT) return;
    this.logT = logT;
    this.wallT = this.wall();
  }

  now(): number | null {
    if (this.logT === null) return null;
    return this.logT + Math.min(Math.max(0, this.wall() - this.wallT), 15 * 60_000);
  }
}

export interface EngineStatus {
  logsDir: string;
  file: string | null;
  lastChange: FileChangeReason | null;
  lines: number;
  error: string | null;
}

export interface EngineSnapshot {
  status: EngineStatus;
  player: LiveSession["player"];
  model: { id: string; label: string } | null;
  log: { version: number | null; advanced: boolean; build: string | null };
  current: LiveFight | null;
}

export interface EngineOptions {
  logsDir: string;
  startAt?: "end" | "start";
  pollMs?: number;
  session?: LiveSessionOptions;
  wall?: () => number;
  onFight?: (fight: CompletedFight) => void;
  onCallout?: (callout: Callout) => void;
}

/** A tailer feeding a live session. `tick()` advances the clock, closes quiet fights and reports the present. */
export class CompanionEngine {
  private session: LiveSession;
  private readonly tailer: LogTailer;
  private readonly clock: LogClock;
  private status: EngineStatus;

  constructor(private readonly opts: EngineOptions) {
    this.session = new LiveSession(opts.session);
    this.clock = new LogClock(opts.wall);
    this.status = { logsDir: opts.logsDir, file: null, lastChange: null, lines: 0, error: null };
    this.tailer = new LogTailer(
      { dir: opts.logsDir, startAt: opts.startAt, pollMs: opts.pollMs },
      {
        onLines: (lines) => {
          this.session.pushLines(lines);
          this.status.lines += lines.length;
          this.clock.seen(this.session.lastEventT);
          this.emit();
        },
        onFileChange: (file, reason) => {
          if (reason !== "initial") this.session.newFile();
          this.status.file = file ? path.join(opts.logsDir, file) : null;
          this.status.lastChange = reason;
          this.status.error = null;
          this.emit();
        },
        onError: (err) => {
          this.status.error = err instanceof Error ? err.message : String(err);
        },
      },
    );
  }

  start() {
    this.tailer.start();
  }

  stop() {
    this.tailer.stop();
    this.session.finish();
    this.emit();
  }

  /** Reads anything new right away (tests, and the watcher hint). */
  poll(): Promise<void> {
    return this.tailer.poll();
  }

  /** Swap player or model settings; the next fight is analysed with them. */
  reconfigure(session: LiveSessionOptions) {
    this.session.finish();
    this.emit();
    this.session = new LiveSession(session);
  }

  tick(): EngineSnapshot {
    const now = this.clock.now();
    if (now !== null) this.session.tick(now);
    const current = now !== null ? this.session.current(now) : null;
    this.emit();
    const model = this.session.model;
    const header = this.session.header;
    return {
      status: { ...this.status },
      player: this.session.player,
      model: model ? { id: model.id, label: model.label } : null,
      log: { version: header.version, advanced: header.advanced, build: header.build },
      current,
    };
  }

  private emit() {
    for (const f of this.session.drainCompleted()) this.opts.onFight?.(f);
    for (const c of this.session.drainCallouts()) this.opts.onCallout?.(c);
  }
}
