/**
 * Append-only NDJSON logger with date rotation + drain backpressure.
 *
 * Each call to {@link NdjsonLogger.write} JSON-stringifies its argument,
 * appends a newline, and writes to the current day's file at
 * `<dir>/round-YYYY-MM-DD.ndjson`. When the date changes, the open
 * stream is ended and a new one is opened.
 *
 * Pruning: a daily setInterval drops files older than `pruneOlderThanDays`.
 *
 * The disk-pressure pipeline (df probe + `setBlocked` + `degraded:'disk'`
 * surface) is implemented here as scaffolding (see `setBlocked` and
 * `diskUsedRatio`) but is intentionally not wired into the worker in
 * PR 1. Wiring + threshold tuning land in PR 3 alongside the rest of
 * the operational guards (NaN-storm / snapshot-age alarms).
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NdjsonLoggerOptions {
  dir: string;
  pruneOlderThanDays: number;
  /** Await drain every N rows. Defaults to 64. */
  flushEvery?: number;
}

export class NdjsonLogger {
  readonly opts: NdjsonLoggerOptions;
  private stream: WriteStream | null = null;
  private currentDay: string | null = null;
  private rowsSinceFlush = 0;
  private blocked = false;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(opts: NdjsonLoggerOptions) {
    this.opts = opts;
  }

  /** Initialize on first use; idempotent. */
  async start(): Promise<void> {
    await fs.mkdir(this.opts.dir, { recursive: true });
    this.openStreamForToday();
    // Daily prune timer.
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => {
        void this.prune();
      }, 24 * 60 * 60 * 1000);
      // Don't keep the worker alive just to prune.
      this.pruneTimer.unref?.();
    }
  }

  /** Stop the logger; closes the current stream and cancels the prune timer. */
  async stop(): Promise<void> {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.stream) {
      const s = this.stream;
      this.stream = null;
      await new Promise<void>((res) => {
        s.end(() => res());
      });
    }
  }

  /** Permanently halt new writes (disk pressure). */
  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  /** Write a single object; awaits drain every `flushEvery` rows. */
  async write(obj: unknown): Promise<void> {
    if (this.blocked) return;
    if (!this.stream) this.openStreamForToday();
    this.rotateIfNeeded();
    const s = this.stream;
    if (!s) return;
    const line = JSON.stringify(obj) + "\n";
    const ok = s.write(line);
    this.rowsSinceFlush += 1;
    const flushEvery = this.opts.flushEvery ?? 64;
    if (!ok || this.rowsSinceFlush >= flushEvery) {
      this.rowsSinceFlush = 0;
      if (!ok) {
        await new Promise<void>((res) => s.once("drain", () => res()));
      }
    }
  }

  /** Open a stream for today's date. Closes any existing one. */
  private openStreamForToday(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.currentDay === today && this.stream) return;
    if (this.stream) {
      const old = this.stream;
      old.end();
    }
    this.currentDay = today;
    this.stream = createWriteStream(path.join(this.opts.dir, `round-${today}.ndjson`), {
      flags: "a",
      encoding: "utf8",
    });
  }

  /** Re-check the date and rotate if it's a new day. */
  rotateIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDay) {
      this.openStreamForToday();
    }
  }

  /** Drop NDJSON files older than `pruneOlderThanDays`. */
  async prune(): Promise<void> {
    const cutoff = Date.now() - this.opts.pruneOlderThanDays * 24 * 60 * 60 * 1000;
    let names: string[];
    try {
      names = await fs.readdir(this.opts.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith("round-") || !name.endsWith(".ndjson")) continue;
      const fp = path.join(this.opts.dir, name);
      try {
        const st = await fs.stat(fp);
        if (st.mtimeMs < cutoff) {
          await fs.unlink(fp);
        }
      } catch {
        /* best-effort */
      }
    }
  }

  /**
   * Probe disk free-space ratio for `dataDir` via `df --output=pcent`.
   * Returns a value in [0, 1] (used / total). Returns 0 on failure so
   * callers default to "no pressure" — disk-pressure-induced shutdown
   * shouldn't fire on a `df` glitch.
   */
  static async diskUsedRatio(dataDir: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync("df", ["-P", dataDir]);
      // Header + data line. Capacity column is the 5th (e.g. "12%").
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length < 2) return 0;
      const cols = lines[1].split(/\s+/);
      const pct = cols[4]; // e.g. "47%"
      const n = Number(pct.replace("%", ""));
      if (!Number.isFinite(n)) return 0;
      return n / 100;
    } catch {
      return 0;
    }
  }
}
