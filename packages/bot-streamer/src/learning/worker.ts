/**
 * worker_threads entrypoint for the streamer-bot learning system.
 *
 * Owns a single {@link WorkerCore} instance; receives messages from the
 * main thread, dispatches to the core, posts responses back. Heartbeat
 * timer fires every 5 s.
 *
 * The file is designed so that running it under `node worker.js` from
 * the parent's `new Worker(__filename, …)` works; if `parentPort` is
 * null (e.g. when imported directly in a test) the file does nothing
 * at module load time.
 */

import { parentPort, workerData } from "node:worker_threads";
import * as os from "node:os";
import { WorkerCore } from "./workerCore";
import { CURRENT_ARCH_HASH } from "./persistence";
import type { WorkerInbound, WorkerOutbound } from "./types";

/**
 * Run the worker against an injected message channel. Exported so the
 * test harness can drive it without spawning an actual thread.
 */
export async function runWorkerLoop(
  port: {
    on: (event: "message", handler: (msg: WorkerInbound) => void) => void;
    postMessage: (msg: WorkerOutbound) => void;
  },
  initialOpts: ConstructorParameters<typeof WorkerCore>[0] = {},
): Promise<{ stop: () => Promise<void> }> {
  const core = new WorkerCore(initialOpts);
  let initialized = false;
  let stopped = false;
  const heartbeatTimer = setInterval(() => {
    if (stopped) return;
    const h = core.health();
    port.postMessage({
      kind: "heartbeat",
      round: core.round,
      bufferSize: h.bufferSize,
      goldenMAE: h.goldenMAE,
      nanRollbacks: h.nanRollbacks,
      gradNormP95: h.gradNormP95,
      gradNormPostClipP95: h.gradNormPostClipP95,
      lastSnapshotRound: h.lastSnapshotRound,
      staleResponses: h.staleResponses,
      teachingMomentsCount: h.teachingMomentsCount,
      degraded: h.degraded,
      snapshotAgeMs: core.snapshotAgeMs(),
      dbWriteLatencyP95Ms: core.dbWriteLatencyP95Ms(),
      diskUsedRatio: core.diskUsedRatio(),
      frozen: core.isFrozen(),
      goldenRegressionRollbacks: h.goldenRegressionRollbacks,
      perTaskObservations: h.perTaskObservations,
      starvedTasks: h.starvedTasks,
      agcClipsP95: h.agcClipsP95,
      agcMinScaleP5: h.agcMinScaleP5,
    });
  }, 5000);
  // Worker should not keep the process alive on its own.
  heartbeatTimer.unref?.();

  // Disk-pressure poll runs at a slower cadence than the heartbeat —
  // df is cheap but not free, and the threshold transitions are rare
  // enough that 60 s granularity beats 5 s.
  const diskTimer = setInterval(() => {
    if (stopped) return;
    void core.checkDiskPressure();
  }, 60_000);
  diskTimer.unref?.();
  // Probe once on startup so /healthz has a real ratio before the
  // first 60 s interval fires.
  void core.checkDiskPressure();

  const handle = async (msg: WorkerInbound): Promise<void> => {
    try {
      if (msg.kind === "init") {
        if (initialized) return;
        // Apply the dataDir from the init message *before* opening
        // persistence. We avoid reconstructing `core` here so there are
        // no constructor invariants to re-enforce — every WorkerCore
        // field is already in its initial state from the constructor
        // above; init() opens persistence and (optionally) loads a
        // snapshot.
        core.setDataDir(msg.dataDir);
        const { loadedSnapshotRound } = await core.init();
        try {
          os.setPriority?.(os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          /* best-effort */
        }
        initialized = true;
        port.postMessage({
          kind: "ready",
          modelVersion: core.health().modelVersion,
          archHash: CURRENT_ARCH_HASH,
          loadedSnapshotRound,
        });
        return;
      }
      if (msg.kind === "predict") {
        const res = core.predict(msg);
        port.postMessage({ kind: "predict_response", ...res });
        return;
      }
      if (msg.kind === "update") {
        const res = core.update(msg);
        port.postMessage({
          kind: "update_response",
          roundId: msg.roundId,
          ok: res.ok,
          loss: res.loss,
          nanRollback: res.nanRollback,
          snapshotRound: res.snapshotRound,
          teachingMomentTriggered: res.teachingMomentTriggered,
        });
        return;
      }
      if (msg.kind === "visual_request") {
        const buf = core.buildVisualBuffer(msg.roundId);
        port.postMessage({ kind: "visual_response", roundId: msg.roundId, tickBuffer: buf });
        return;
      }
      if (msg.kind === "reset") {
        await core.resetLearning();
        port.postMessage({ kind: "reset_ack" });
        return;
      }
      if (msg.kind === "shutdown") {
        await core.shutdown();
        clearInterval(heartbeatTimer);
        clearInterval(diskTimer);
        stopped = true;
        // Tell the bridge it's safe to terminate the thread now that
        // the final snapshot + NDJSON flush completed.
        port.postMessage({ kind: "shutdown_ack" });
        return;
      }
    } catch (err) {
      port.postMessage({
        kind: "error",
        code: "worker_error",
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  port.on("message", (m) => {
    void handle(m);
  });

  return {
    stop: async () => {
      clearInterval(heartbeatTimer);
      clearInterval(diskTimer);
      stopped = true;
      await core.shutdown();
    },
  };
}

// Auto-start when run as a real worker thread.
if (parentPort) {
  void runWorkerLoop(parentPort, workerData ?? {}).catch((err) => {
    parentPort!.postMessage({
      kind: "error",
      code: "worker_init_failed",
      msg: err instanceof Error ? err.message : String(err),
    });
  });
}
