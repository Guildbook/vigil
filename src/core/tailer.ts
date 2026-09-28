import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { LineSplitter } from "@/lib/combatlog/lines";

/**
 * Follows the newest WoWCombatLog*.txt in a Logs folder the way `tail -F` would. It only ever opens the
 * files for reading, and it survives what the client does to them: a new file per /combatlog session,
 * truncation, the file being deleted and recreated, and writes that stop mid-line.
 */

export type FileChangeReason = "initial" | "new-session" | "truncated" | "replaced" | "gone";

export interface TailerHandlers {
  onLines(lines: string[], file: string): void;
  onFileChange?(file: string | null, reason: FileChangeReason): void;
  onError?(err: unknown): void;
}

export interface TailerOptions {
  dir: string;
  pattern?: RegExp;
  pollMs?: number;
  /** On first attach, skip what the file already holds (default) or replay it from the start. */
  startAt?: "end" | "start";
  /** Largest single read; bigger backlogs are read in several chunks. */
  chunkBytes?: number;
}

export const COMBAT_LOG_PATTERN = /^WoWCombatLog.*\.txt$/i;

interface Current {
  file: string;
  ino: number;
  offset: number;
  /** The file's first bytes. If they change, it was rewritten, even if it has regrown past our offset. */
  head: Buffer;
}

const HEAD_BYTES = 256;

export class LogTailer {
  private current: Current | null = null;
  private readonly splitter = new LineSplitter();
  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private polling: Promise<void> | null = null;
  private again = false;
  private attached = false;

  constructor(
    private readonly opts: TailerOptions,
    private readonly handlers: TailerHandlers,
  ) {}

  get file(): string | null {
    return this.current?.file ?? null;
  }

  get offset(): number {
    return this.current?.offset ?? 0;
  }

  /** Text after the last complete line, waiting for the client to finish writing it. */
  get pendingText(): string {
    return this.splitter.pending;
  }

  start() {
    this.stop();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 500);
    try {
      // A hint to read sooner; polling alone is enough (fs.watch is unreliable on network drives and Windows).
      this.watcher = watch(this.opts.dir, { persistent: false }, () => void this.poll());
      this.watcher.on("error", () => this.watcher?.close());
    } catch {
      this.watcher = null;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** One pass: pick the file to follow and read whatever was appended. Concurrent calls coalesce. */
  poll(): Promise<void> {
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    this.polling = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } catch (err) {
        this.handlers.onError?.(err);
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  private async pass() {
    const newest = await this.newestLog();
    const cur = this.current;

    if (!newest) {
      // Watching an empty folder counts as attached: a log that appears later is a new session, read whole.
      this.attached = true;
      if (cur) {
        this.emitLines(this.splitter.flush(), cur.file);
        this.current = null;
        this.handlers.onFileChange?.(null, "gone");
      }
      return;
    }

    if (!cur || newest.file !== cur.file) {
      if (cur) {
        // Finish the old session before moving on: the client may have flushed its last lines late.
        await this.readFrom(cur).catch(() => undefined);
        this.emitLines(this.splitter.flush(), cur.file);
      }
      const initial = !this.attached;
      this.attached = true;
      this.splitter.reset();
      this.current = {
        file: newest.file,
        ino: newest.ino,
        offset: initial && (this.opts.startAt ?? "end") === "end" ? newest.size : 0,
        head: Buffer.alloc(0),
      };
      this.handlers.onFileChange?.(newest.file, initial ? "initial" : "new-session");
    } else if (newest.ino !== cur.ino) {
      this.emitLines(this.splitter.flush(), cur.file);
      this.current = { file: newest.file, ino: newest.ino, offset: 0, head: Buffer.alloc(0) };
      this.handlers.onFileChange?.(newest.file, "replaced");
    } else if (newest.size < cur.offset || !(await this.readHead(cur.file, cur.head.length)).equals(cur.head)) {
      this.splitter.reset();
      cur.offset = 0;
      cur.head = Buffer.alloc(0);
      this.handlers.onFileChange?.(cur.file, "truncated");
    }

    const next = this.current!;
    await this.readFrom(next);
    if (next.head.length < HEAD_BYTES && newest.size > next.head.length) {
      next.head = await this.readHead(next.file, Math.min(HEAD_BYTES, newest.size));
    }
  }

  private async readHead(file: string, bytes: number): Promise<Buffer> {
    if (bytes === 0) return Buffer.alloc(0);
    const handle = await fs.open(path.join(this.opts.dir, file), "r");
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private async readFrom(cur: Current) {
    const full = path.join(this.opts.dir, cur.file);
    const handle = await fs.open(full, "r");
    try {
      const size = this.opts.chunkBytes ?? 4 * 1024 * 1024;
      const buf = Buffer.allocUnsafe(size);
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, size, cur.offset);
        if (bytesRead === 0) break;
        cur.offset += bytesRead;
        this.emitLines(this.splitter.push(buf.subarray(0, bytesRead)), cur.file);
        if (bytesRead < size) break;
      }
    } finally {
      await handle.close();
    }
  }

  private emitLines(lines: string[], file: string) {
    if (lines.length > 0) this.handlers.onLines(lines, file);
  }

  private async newestLog(): Promise<{ file: string; ino: number; size: number } | null> {
    let names: string[];
    try {
      names = await fs.readdir(this.opts.dir);
    } catch {
      return null;
    }
    const pattern = this.opts.pattern ?? COMBAT_LOG_PATTERN;
    let best: { file: string; ino: number; size: number; born: number; mtime: number } | null = null;
    for (const name of names) {
      if (!pattern.test(name)) continue;
      try {
        const st = await fs.stat(path.join(this.opts.dir, name));
        if (!st.isFile()) continue;
        // The most recently created file is the current session; a late flush to the previous one must not
        // pull us back. Where creation time is unavailable (0), fall back to the last write.
        const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
        const cand = { file: name, ino: st.ino, size: st.size, born, mtime: st.mtimeMs };
        const later =
          !best ||
          cand.born > best.born ||
          (cand.born === best.born && (cand.mtime > best.mtime || (cand.mtime === best.mtime && name > best.file)));
        if (later) best = cand;
      } catch {
        // Deleted between readdir and stat.
      }
    }
    return best;
  }
}
