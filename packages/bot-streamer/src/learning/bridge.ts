/**
 * Main-thread wrapper around the learning Worker.
 *
 * Responsibilities:
 *   - Spawns the worker via `worker_threads` (or accepts an injected
 *     transport for tests).
 *   - Routes `predict` requests with a 150 ms staleness budget; over →
 *     resolves to null + increments staleResponses (the strategy falls
 *     back to its heuristic centerpoint).
 *   - Fire-and-forget `update` and `visual_request`.
 *   - Tracks worker heartbeat; >30 s without one → restart the worker.
 *   - Exposes `health()` for /healthz.
 *
 * The bridge has three modes: `off` (no-op pass-through), `shadow`
 * (predict/update fire normally but the strategy ignores predictions),
 * and `active` (predict drives strategy choice).
 */

import { Worker } from "node:worker_threads";
import path from "node:path";
import { runWorkerLoop } from "./worker";
import type {
  LearningHealthBlock,
  PredictReq,
  PredictRes,
  UpdateReq,
  WorkerInbound,
  WorkerOutbound,
} from "./types";

/** Modes a bridge can operate in. */
export type LearningMode = "off" | "shadow" | "active";

export interface BridgeStartOptions {
  dataDir: string;
  mode: LearningMode;
  /** Optional pre-built transport for tests. */
  transport?: WorkerTransport;
  /** Path to the compiled worker JS — production uses `dist/learning/worker.js`. */
  workerScriptPath?: string;
  /** Worker-core options to forward as workerData. */
  workerOptions?: Record<string, unknown>;
  /** Predict timeout (ms). */
  predictTimeoutMs?: number;
}

export interface WorkerTransport {
  postMessage(msg: WorkerInbound): void;
  on(handler: (msg: WorkerOutbound) => void): void;
  terminate(): Promise<void>;
}

interface PendingPredict {
  resolve(res: PredictRes | null): void;
  timer: NodeJS.Timeout;
  expiresAt: number;
}

/**
 * The main-thread learning bridge.
 *
 * Lifecycle: `start()` → `predict/update/getVisual/health` → `stop()`.
 */
export class LearningBridge {
  private transport: WorkerTransport | null = null;
  private inProcessHandle: { stop: () => Promise<void> } | null = null;
  private pending = new Map<string, PendingPredict>();
  private mode: LearningMode = "off";
  private dataDir = "/var/streamer/data";
  private startOpts: BridgeStartOptions | null = null;
  /** Latest heartbeat fields, mirrored for health(). */
  private last: Partial<LearningHealthBlock> & {
    lastHeartbeatAt: number;
    snapshotAgeMs: number;
    dbWriteLatencyP95Ms: number;
    diskUsedRatio: number;
    frozen: boolean;
  } = {
    enabled: false,
    mode: "off",
    lastSnapshotRound: 0,
    nanRollbacks: 0,
    goldenMAE: null,
    staleResponses: 0,
    workerHeartbeatMs: 0,
    bufferSize: 0,
    teachingMomentsCount: 0,
    modelVersion: "unset",
    degraded: false,
    gradNormP95: 0,
    gradNormPostClipP95: 0,
    lastHeartbeatAt: 0,
    snapshotAgeMs: 0,
    dbWriteLatencyP95Ms: 0,
    diskUsedRatio: 0,
    frozen: false,
  };
  private staleResponses = 0;
  private predictTimeoutMs = 150;
  /**
   * Phase 3e.0: starved-task list from the previous heartbeat. Used
   * to log only when a head TRANSITIONS into the starved set, not on
   * every subsequent heartbeat the watchdog stays tripped.
   */
  private lastStarvedTasks: ReadonlyArray<string> = [];
  /**
   * Pending resolvers awaiting `reset_ack`. A list rather than a
   * single slot so concurrent callers don't clobber each other —
   * every caller's promise resolves on the next ack arrival.
   */
  private resetAckResolvers: Array<() => void> = [];
  /**
   * Watchdog for worker_dead — set when the bridge sees a heartbeat-age
   * over 30 s and runs once to terminate + respawn the transport.
   */
  private restartTimer: NodeJS.Timeout | null = null;
  /**
   * Guards against concurrent restarts when `terminate()` runs slowly
   * (>10 s, the watchdog interval). Without this two ticks could each
   * see `transport === null` and start two `runWorkerLoop` instances.
   */
  private restartInFlight = false;

  /** Start the worker. */
  async start(opts: BridgeStartOptions): Promise<void> {
    if (this.transport) return; // idempotent
    this.dataDir = opts.dataDir;
    this.mode = opts.mode;
    this.predictTimeoutMs = opts.predictTimeoutMs ?? 150;
    // Cache start options so the heartbeat watchdog can respawn the
    // worker on death without the caller having to re-supply them.
    this.startOpts = opts;
    if (this.mode === "off") {
      this.last.enabled = false;
      this.last.mode = "off";
      return;
    }
    this.armRestartWatchdog();
    if (opts.transport) {
      this.transport = opts.transport;
      this.transport.on((msg) => this.onMessage(msg));
      this.transport.postMessage({ kind: "init", dataDir: opts.dataDir, archHash: "" });
    } else if (opts.workerScriptPath) {
      // Real worker_threads.
      const w = new Worker(opts.workerScriptPath, {
        workerData: opts.workerOptions ?? { dataDir: opts.dataDir },
      });
      this.transport = {
        postMessage: (m) => w.postMessage(m),
        on: (h) => w.on("message", h),
        terminate: async () => {
          await w.terminate();
        },
      };
      this.transport.on((msg) => this.onMessage(msg));
      this.transport.postMessage({ kind: "init", dataDir: opts.dataDir, archHash: "" });
    } else {
      // In-process transport — drives the worker module directly. Tests
      // and dev mode can use this; production should pass an explicit
      // workerScriptPath.
      const inboundHandlers: Array<(msg: WorkerOutbound) => void> = [];
      let outboundHandler: ((msg: WorkerInbound) => void) | null = null;
      const port = {
        on: (_evt: "message", h: (msg: WorkerInbound) => void) => {
          outboundHandler = h;
        },
        postMessage: (m: WorkerOutbound) => {
          for (const fn of inboundHandlers) fn(m);
        },
      };
      this.inProcessHandle = await runWorkerLoop(port, opts.workerOptions ?? {});
      this.transport = {
        postMessage: (m) => outboundHandler?.(m),
        on: (h) => {
          inboundHandlers.push(h);
        },
        terminate: async () => {
          await this.inProcessHandle?.stop();
        },
      };
      this.transport.on((msg) => this.onMessage(msg));
      this.transport.postMessage({ kind: "init", dataDir: opts.dataDir, archHash: "" });
    }
    this.last.enabled = true;
    this.last.mode = this.mode;
  }

  /**
   * Stop the worker. Posts `shutdown`, waits up to 25 s for the
   * worker's `shutdown_ack` (which is sent only after the final
   * snapshot + NDJSON flush complete), then terminates the transport.
   * Without this wait `worker_threads.terminate()` would kill the
   * thread mid-snapshot and lose data.
   */
  async stop(opts: { timeoutMs?: number } = {}): Promise<void> {
    if (this.restartTimer) {
      clearInterval(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.transport) return;
    const timeoutMs = opts.timeoutMs ?? 25_000;
    // Resolve any pending predicts to null up front so callers don't
    // hang on a worker that's already past the point of replying.
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
    const ackPromise = new Promise<void>((resolve) => {
      this.shutdownAckResolve = resolve;
    });
    try {
      this.transport.postMessage({ kind: "shutdown" });
    } catch {
      /* best-effort — proceed to terminate anyway */
    }
    await Promise.race([
      ackPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    try {
      await this.transport.terminate();
    } catch {
      /* best-effort */
    }
    this.transport = null;
    this.shutdownAckResolve = null;
  }
  private shutdownAckResolve: (() => void) | null = null;

  /**
   * Run a prediction with a 150 ms staleness budget. Returns null on
   * timeout; the caller falls back to its heuristic centerpoint.
   */
  predict(req: PredictReq): Promise<PredictRes | null> {
    if (this.mode === "off" || !this.transport) return Promise.resolve(null);
    return new Promise<PredictRes | null>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(req.roundId);
        if (pending) {
          this.pending.delete(req.roundId);
          this.staleResponses += 1;
          this.last.staleResponses = this.staleResponses;
          pending.resolve(null);
        }
      }, this.predictTimeoutMs);
      this.pending.set(req.roundId, {
        resolve,
        timer,
        expiresAt: Date.now() + this.predictTimeoutMs,
      });
      this.transport!.postMessage({ kind: "predict", ...req });
    });
  }

  /** Fire-and-forget update. */
  update(req: UpdateReq): void {
    if (this.mode === "off" || !this.transport) return;
    this.transport.postMessage({ kind: "update", ...req });
  }

  /** Request a visual tick for the given round. Awaits the response. */
  getVisual(roundId: string, timeoutMs = 200): Promise<Buffer | null> {
    if (this.mode === "off" || !this.transport) return Promise.resolve(null);
    return new Promise<Buffer | null>((resolve) => {
      const timer = setTimeout(() => {
        this.visualPending.delete(roundId);
        resolve(null);
      }, timeoutMs);
      this.visualPending.set(roundId, { resolve, timer });
      this.transport!.postMessage({ kind: "visual_request", roundId });
    });
  }
  private visualPending = new Map<string, { resolve(b: Buffer | null): void; timer: NodeJS.Timeout }>();

  /** Health snapshot. */
  health(): LearningHealthBlock {
    const heartbeatAge = this.last.lastHeartbeatAt > 0
      ? Date.now() - this.last.lastHeartbeatAt
      : 0;
    const degraded = heartbeatAge > 30_000 ? "worker_dead" : (this.last.degraded ?? false);
    return {
      enabled: this.last.enabled ?? false,
      mode: this.last.mode ?? "off",
      lastSnapshotRound: this.last.lastSnapshotRound ?? 0,
      nanRollbacks: this.last.nanRollbacks ?? 0,
      goldenMAE: this.last.goldenMAE ?? null,
      staleResponses: this.staleResponses,
      workerHeartbeatMs: heartbeatAge,
      bufferSize: this.last.bufferSize ?? 0,
      teachingMomentsCount: this.last.teachingMomentsCount ?? 0,
      modelVersion: this.last.modelVersion ?? "unset",
      degraded: degraded as LearningHealthBlock["degraded"],
      gradNormP95: this.last.gradNormP95 ?? 0,
      gradNormPostClipP95: this.last.gradNormPostClipP95 ?? 0,
      snapshotAgeMs: this.last.snapshotAgeMs,
      dbWriteLatencyP95Ms: this.last.dbWriteLatencyP95Ms,
      diskUsedRatio: this.last.diskUsedRatio,
      frozen: this.last.frozen,
      goldenRegressionRollbacks: this.last.goldenRegressionRollbacks ?? 0,
      perTaskObservations: this.last.perTaskObservations ?? [],
      starvedTasks: this.last.starvedTasks ?? [],
      agcClipsP95: this.last.agcClipsP95 ?? 0,
      agcMinScaleP5: this.last.agcMinScaleP5 ?? 1,
    };
  }

  /** Expose for tests. */
  inspect(): { pendingCount: number } {
    return { pendingCount: this.pending.size };
  }

  private onMessage(msg: WorkerOutbound): void {
    switch (msg.kind) {
      case "ready": {
        this.last.modelVersion = msg.modelVersion;
        this.last.lastHeartbeatAt = Date.now();
        return;
      }
      case "heartbeat": {
        this.last.lastHeartbeatAt = Date.now();
        this.last.bufferSize = msg.bufferSize;
        this.last.goldenMAE = msg.goldenMAE;
        this.last.nanRollbacks = msg.nanRollbacks;
        this.last.gradNormP95 = msg.gradNormP95;
        this.last.gradNormPostClipP95 = msg.gradNormPostClipP95;
        this.last.lastSnapshotRound = msg.lastSnapshotRound;
        this.last.staleResponses = msg.staleResponses;
        this.last.teachingMomentsCount = msg.teachingMomentsCount;
        this.last.degraded = msg.degraded;
        this.last.snapshotAgeMs = msg.snapshotAgeMs;
        this.last.dbWriteLatencyP95Ms = msg.dbWriteLatencyP95Ms;
        this.last.diskUsedRatio = msg.diskUsedRatio;
        this.last.frozen = msg.frozen;
        this.last.goldenRegressionRollbacks = msg.goldenRegressionRollbacks;
        // Phase 3e.0 fields are nullable for back-compat with mocked
        // heartbeats in tests + old workers that haven't shipped yet.
        const starved = msg.starvedTasks ?? [];
        this.last.perTaskObservations = msg.perTaskObservations ?? [];
        this.last.starvedTasks = starved;
        this.last.agcClipsP95 = msg.agcClipsP95 ?? 0;
        this.last.agcMinScaleP5 = msg.agcMinScaleP5 ?? 1;
        // Log when a head first transitions into starvation. The
        // starved-list is small (≤NUM_ACTIVE_TASKS=5), so a one-shot
        // diff is cheap; we log only on transitions to avoid spamming
        // when the watchdog stays tripped over many heartbeats.
        const prevSet = new Set(this.lastStarvedTasks);
        for (const name of starved) {
          if (!prevSet.has(name)) {
            console.warn(
              `[learning] head-starvation: task '${name}' has 0 observations after ${msg.round} rounds — upstream data path may be broken`,
            );
          }
        }
        this.lastStarvedTasks = starved;
        return;
      }
      case "predict_response": {
        const pending = this.pending.get(msg.roundId);
        if (!pending) return; // already timed out
        clearTimeout(pending.timer);
        this.pending.delete(msg.roundId);
        // Reconstruct PredictRes (drop the `kind` discriminator).
        // Strip the discriminator and forward every other field. This
        // way new fields on PredictRes don't require a dual-edit here.
        const { kind: _kind, ...res } = msg;
        void _kind;
        pending.resolve(res as unknown as PredictRes);
        return;
      }
      case "update_response": {
        if (msg.nanRollback) {
          // surface it via lastDegraded heartbeat eventually; for now
          // just bump the counter visible in next heartbeat.
        }
        return;
      }
      case "visual_response": {
        const v = this.visualPending.get(msg.roundId);
        if (!v) return;
        clearTimeout(v.timer);
        this.visualPending.delete(msg.roundId);
        v.resolve(msg.tickBuffer);
        return;
      }
      case "shutdown_ack": {
        this.shutdownAckResolve?.();
        return;
      }
      case "reset_ack": {
        // Resolve ALL pending callers — every concurrent reset() awaits
        // the same single worker ack.
        const pending = this.resetAckResolvers;
        this.resetAckResolvers = [];
        for (const resolve of pending) resolve();
        return;
      }
      case "error": {
        // eslint-disable-next-line no-console
        console.warn(`[learning] worker error: ${msg.code} — ${msg.msg}`);
        return;
      }
    }
  }

  /**
   * Wipe the learning state and start fresh from random init. Used by
   * the operator's `/api/streamer/reset-learning` admin endpoint when
   * the model has wedged itself badly enough that rollback can't
   * recover. Awaits a `reset_ack` from the worker; resolves whether
   * the ack arrives or the 5 s timeout fires (the worker's reset is
   * synchronous on its own thread so the ack should be near-instant).
   */
  async reset(timeoutMs = 5_000): Promise<void> {
    if (this.mode === "off" || !this.transport) return;
    const p = new Promise<void>((resolve) => {
      this.resetAckResolvers.push(resolve);
    });
    try {
      this.transport.postMessage({ kind: "reset" });
    } catch {
      // Drop the resolver we just queued — no ack will arrive.
      const idx = this.resetAckResolvers.length - 1;
      if (idx >= 0) this.resetAckResolvers.splice(idx, 1);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      p,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Arm the heartbeat-watchdog. Polls every 10 s; if the most recent
   * heartbeat is more than 30 s old, terminates the current transport
   * and respawns it from `this.startOpts`. Worker-thread death is the
   * canonical "the model wedged so badly the worker crashed" signal —
   * the bot continues on heuristic until the new worker boots, then
   * resumes online learning from the latest persisted snapshot.
   */
  private armRestartWatchdog(): void {
    if (this.restartTimer) return;
    this.restartTimer = setInterval(() => {
      void this.maybeRestartWorker();
    }, 10_000);
    this.restartTimer.unref?.();
  }

  /** Watchdog tick — public so tests can drive it deterministically. */
  async maybeRestartWorker(): Promise<void> {
    if (this.restartInFlight) return;
    if (!this.transport) return;
    if (this.last.lastHeartbeatAt === 0) return;
    const age = Date.now() - this.last.lastHeartbeatAt;
    if (age <= 30_000) return;
    const opts = this.startOpts;
    if (!opts) return;
    this.restartInFlight = true;
    // eslint-disable-next-line no-console
    console.warn(`[learning] worker heartbeat absent for ${age} ms — restarting`);
    try {
      try {
        await this.transport.terminate();
      } catch {
        /* best-effort */
      }
      this.transport = null;
      // Reset heartbeat marker so the next watchdog tick gives the
      // new worker a fair shot at first heartbeat before re-firing.
      this.last.lastHeartbeatAt = Date.now();
      // Phase 3e.0: clear the starvation-diff cache so the new
      // worker's first heartbeat re-emits warning lines for any
      // heads still starved post-restart. Without this, an operator
      // who restarted *because* of a starvation alert would see no
      // log line confirming the head is still un-trained on the
      // fresh worker.
      this.lastStarvedTasks = [];
      try {
        const respawnOpts = { ...opts, transport: undefined };
        await this.start(respawnOpts);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[learning] worker respawn failed: ${(err as Error).message}`);
      }
    } finally {
      this.restartInFlight = false;
    }
  }
}

/** Compute the worker script path relative to the compiled bot-streamer dist. */
export function defaultWorkerScriptPath(): string {
  return path.join(__dirname, "worker.js");
}
