import { describe, expect, it, vi } from "vitest";
import { LearningBridge, type WorkerTransport } from "../../src/learning/bridge";
import type { WorkerInbound, WorkerOutbound } from "../../src/learning/types";

/** Build an in-memory transport that records messages and lets tests reply. */
function makeMockTransport(): {
  transport: WorkerTransport;
  sent: WorkerInbound[];
  replyTo(handler: (msg: WorkerInbound) => WorkerOutbound | null): void;
  emit(msg: WorkerOutbound): void;
} {
  const sent: WorkerInbound[] = [];
  let listener: ((msg: WorkerOutbound) => void) | null = null;
  let autoHandler: ((msg: WorkerInbound) => WorkerOutbound | null) | null = null;
  const transport: WorkerTransport = {
    postMessage: (msg) => {
      sent.push(msg);
      // Default behavior: reply to `shutdown` with `shutdown_ack` so
      // bridge.stop() doesn't hang in tests. Tests can override via
      // replyTo() but we still always ack a shutdown.
      if (msg.kind === "shutdown") {
        if (listener) listener({ kind: "shutdown_ack" });
        return;
      }
      if (autoHandler) {
        const reply = autoHandler(msg);
        if (reply && listener) listener(reply);
      }
    },
    on: (h) => {
      listener = h;
    },
    terminate: async () => {
      /* noop */
    },
  };
  return {
    transport,
    sent,
    replyTo(h) {
      autoHandler = h;
    },
    emit(msg) {
      listener?.(msg);
    },
  };
}

describe("LearningBridge", () => {
  it("off mode is a no-op", async () => {
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "off" });
    const r = await b.predict({ roundId: "x", mode: "classic", product: { id: 1, title: "t", category: "c" } });
    expect(r).toBeNull();
    b.update({ roundId: "x", revealedSamples: [], primaryMode: "classic", outcome: "incorrect" });
    expect(b.health().enabled).toBe(false);
    await b.stop();
  });

  it("predict resolves with response from worker", async () => {
    const m = makeMockTransport();
    m.replyTo((msg) => {
      if (msg.kind === "init") {
        return {
          kind: "ready",
          modelVersion: "v1",
          archHash: "h",
          loadedSnapshotRound: null,
        };
      }
      if (msg.kind === "predict") {
        return {
          kind: "predict_response",
          roundId: msg.roundId,
          predictedCents: 100,
          predictedSigmaCents: 50,
          embedding2d: [0.1, 0.2],
          topFeatures: [],
          ageMs: 1,
          explorationDraw: 100,
        };
      }
      return null;
    });
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "active", transport: m.transport });
    const res = await b.predict({ roundId: "r1", mode: "classic", product: { id: 1, title: "t", category: "c" } });
    expect(res).not.toBeNull();
    expect(res?.predictedCents).toBe(100);
    await b.stop();
  });

  it("predict resolves to null on timeout", async () => {
    const m = makeMockTransport();
    // No reply for predict messages.
    m.replyTo((msg) => (msg.kind === "init" ? { kind: "ready", modelVersion: "v", archHash: "", loadedSnapshotRound: null } : null));
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "active", transport: m.transport, predictTimeoutMs: 50 });
    const res = await b.predict({ roundId: "rOOM", mode: "classic", product: { id: 1, title: "t", category: "c" } });
    expect(res).toBeNull();
    expect(b.health().staleResponses).toBe(1);
    await b.stop();
  });

  it("heartbeat keeps health fresh; absence flips to worker_dead", async () => {
    const m = makeMockTransport();
    m.replyTo((msg) => (msg.kind === "init" ? { kind: "ready", modelVersion: "v", archHash: "", loadedSnapshotRound: null } : null));
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "active", transport: m.transport });
    m.emit({
      kind: "heartbeat",
      round: 5,
      bufferSize: 12,
      goldenMAE: 100,
      nanRollbacks: 0,
      gradNormP95: 1.5,
      lastSnapshotRound: 5,
      staleResponses: 0,
      teachingMomentsCount: 1,
      degraded: false,
      snapshotAgeMs: 0,
      dbWriteLatencyP95Ms: 0,
      diskUsedRatio: 0,
      frozen: false,
    });
    let h = b.health();
    expect(h.bufferSize).toBe(12);
    expect(h.degraded).toBe(false);

    // Simulate >30s without heartbeat by mutating the internal field.
    (b as unknown as { last: { lastHeartbeatAt: number } }).last.lastHeartbeatAt = Date.now() - 31_000;
    h = b.health();
    expect(h.degraded).toBe("worker_dead");
    await b.stop();
  });

  it("update is fire-and-forget", async () => {
    const m = makeMockTransport();
    m.replyTo((msg) => (msg.kind === "init" ? { kind: "ready", modelVersion: "v", archHash: "", loadedSnapshotRound: null } : null));
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "active", transport: m.transport });
    b.update({ roundId: "u1", revealedSamples: [], primaryMode: "classic", outcome: "correct" });
    expect(m.sent.some((s) => s.kind === "update")).toBe(true);
    await b.stop();
  });

  it("reset() awaits reset_ack and resolves all concurrent callers", async () => {
    const m = makeMockTransport();
    let resetCount = 0;
    m.replyTo((msg) => {
      if (msg.kind === "init") return { kind: "ready", modelVersion: "v", archHash: "", loadedSnapshotRound: null };
      if (msg.kind === "reset") {
        resetCount += 1;
        // Defer the ack so the bridge's promise actually waits.
        setTimeout(() => m.emit({ kind: "reset_ack" }), 0);
        return null;
      }
      return null;
    });
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "active", transport: m.transport });
    // Concurrent callers — both should resolve.
    const a = b.reset(1_000);
    const c = b.reset(1_000);
    await Promise.all([a, c]);
    expect(resetCount).toBe(2);
    await b.stop();
  });

  it("reset() resolves on timeout when ack never arrives", async () => {
    const m = makeMockTransport();
    m.replyTo((msg) => (msg.kind === "init" ? { kind: "ready", modelVersion: "v", archHash: "", loadedSnapshotRound: null } : null));
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "active", transport: m.transport });
    const t0 = Date.now();
    await b.reset(50);
    expect(Date.now() - t0).toBeLessThan(500);
    await b.stop();
  });

  it("maybeRestartWorker is a no-op when heartbeat is fresh", async () => {
    const m = makeMockTransport();
    m.replyTo((msg) => (msg.kind === "init" ? { kind: "ready", modelVersion: "v", archHash: "", loadedSnapshotRound: null } : null));
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "active", transport: m.transport });
    // Fresh heartbeat from the ready message.
    await b.maybeRestartWorker();
    // Bridge transport remains the same instance — no respawn.
    expect((b as unknown as { transport: unknown }).transport).toBe(m.transport);
    await b.stop();
  });

  it("maybeRestartWorker terminates and respawns when heartbeat ages out", async () => {
    const m = makeMockTransport();
    m.replyTo((msg) => (msg.kind === "init" ? { kind: "ready", modelVersion: "v", archHash: "", loadedSnapshotRound: null } : null));
    const terminate = vi.fn(async () => { /* noop */ });
    m.transport.terminate = terminate;
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "active", transport: m.transport });
    // Force the heartbeat to look 31 s old.
    (b as unknown as { last: { lastHeartbeatAt: number } }).last.lastHeartbeatAt = Date.now() - 31_000;
    await b.maybeRestartWorker();
    expect(terminate).toHaveBeenCalled();
    await b.stop();
  });

  it("getVisual resolves with the worker's tickBuffer", async () => {
    const m = makeMockTransport();
    m.replyTo((msg) => {
      if (msg.kind === "init") return { kind: "ready", modelVersion: "v", archHash: "", loadedSnapshotRound: null };
      if (msg.kind === "visual_request") {
        return { kind: "visual_response", roundId: msg.roundId, tickBuffer: Buffer.from("hi", "utf8") };
      }
      return null;
    });
    const b = new LearningBridge();
    await b.start({ dataDir: "/tmp", mode: "active", transport: m.transport });
    const buf = await b.getVisual("v1");
    expect(buf?.toString("utf8")).toBe("hi");
    await b.stop();
  });
});
