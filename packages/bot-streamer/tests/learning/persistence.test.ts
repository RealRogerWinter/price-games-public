import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import { LearningPersistence, SCHEMA_VERSION } from "../../src/learning/persistence";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "nnpersist-"));
}

function dummyPayload(round: number) {
  return {
    round,
    weights: Buffer.from([1, 2, 3, 4]),
    optimizerState: Buffer.from([5, 6]),
    featureNorm: Buffer.from([7]),
    replayBuffer: Buffer.from([8, 9, 10]),
    teachingMoments: Buffer.from([11]),
    oodBlender: Buffer.from([12, 13]),
    uncertaintyWeights: Buffer.from([14]),
  };
}

describe("LearningPersistence", () => {
  it("creates DB + tables", async () => {
    const dir = await tmpDir();
    const p = await LearningPersistence.open({ dataDir: dir });
    // Verify tables exist
    const rows = p.rawDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toContain("nn_snapshots");
    expect(names).toContain("nn_round_log");
    p.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("save → load round-trips identical bytes", async () => {
    const dir = await tmpDir();
    const p = await LearningPersistence.open({ dataDir: dir });
    p.saveSnapshot(dummyPayload(42));
    const loaded = p.loadLatestSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded?.round).toBe(42);
    expect(Array.from(loaded!.weights)).toEqual([1, 2, 3, 4]);
    expect(Array.from(loaded!.replayBuffer)).toEqual([8, 9, 10]);
    p.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when no snapshots exist", async () => {
    const dir = await tmpDir();
    const p = await LearningPersistence.open({ dataDir: dir });
    expect(p.loadLatestSnapshot()).toBeNull();
    p.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("archives on archHash mismatch", async () => {
    const dir = await tmpDir();
    const p1 = await LearningPersistence.open({ dataDir: dir, archHashOverride: "OLD_HASH" });
    p1.saveSnapshot(dummyPayload(1));
    p1.saveSnapshot(dummyPayload(2));
    p1.close();
    // Reopen with a different arch hash → load should archive + return null.
    const p2 = await LearningPersistence.open({ dataDir: dir, archHashOverride: "NEW_HASH" });
    expect(p2.loadLatestSnapshot()).toBeNull();
    const archived = p2.rawDb
      .prepare("SELECT count(*) as c FROM nn_snapshots_archived")
      .get() as { c: number };
    expect(archived.c).toBe(2);
    const remaining = p2.rawDb.prepare("SELECT count(*) as c FROM nn_snapshots").get() as { c: number };
    expect(remaining.c).toBe(0);
    p2.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loads only when archHash matches", async () => {
    const dir = await tmpDir();
    const p = await LearningPersistence.open({ dataDir: dir, archHashOverride: "abc" });
    p.saveSnapshot(dummyPayload(7));
    const loaded = p.loadLatestSnapshot();
    expect(loaded?.archHash).toBe("abc");
    p.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("logRound appends rows", async () => {
    const dir = await tmpDir();
    const p = await LearningPersistence.open({ dataDir: dir });
    p.logRound({ round: 1, mode: "classic", outcome: "correct", loss: 0.1, gradNorm: 1.2 });
    p.logRound({ round: 2, mode: "comparison", outcome: "incorrect", loss: 0.5, gradNorm: 0.8 });
    const c = p.rawDb.prepare("SELECT count(*) as c FROM nn_round_log").get() as { c: number };
    expect(c.c).toBe(2);
    p.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("schema: fresh DB has grad_norm_post_clip column on nn_round_log", async () => {
    const dir = await tmpDir();
    const p = await LearningPersistence.open({ dataDir: dir });
    const cols = p.rawDb
      .prepare("PRAGMA table_info(nn_round_log)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("grad_norm_post_clip");
    p.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("SCHEMA_VERSION constant is 3 (Phase 3e.2 — filmGen layout shrink)", () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  it("schema: logRound persists gradNormPostClip and null perTaskLosses", async () => {
    const dir = await tmpDir();
    const p = await LearningPersistence.open({ dataDir: dir });
    p.logRound({
      round: 1,
      mode: "classic",
      outcome: "correct",
      loss: 0.1,
      gradNorm: 5.5,
      gradNormPostClip: 0.5,
      perTaskLosses: null,
    });
    p.logRound({
      round: 2,
      mode: "comparison",
      outcome: "incorrect",
      loss: 0.2,
      gradNorm: 1.0,
      gradNormPostClip: 1.0,
      perTaskLosses: null,
    });
    const rows = p.rawDb
      .prepare(
        "SELECT round, grad_norm, grad_norm_post_clip, per_task_losses FROM nn_round_log ORDER BY round",
      )
      .all() as Array<{
      round: number;
      grad_norm: number;
      grad_norm_post_clip: number | null;
      per_task_losses: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].grad_norm).toBeCloseTo(5.5);
    expect(rows[0].grad_norm_post_clip).toBeCloseTo(0.5);
    expect(rows[0].per_task_losses).toBeNull();
    expect(rows[1].grad_norm_post_clip).toBeCloseTo(1.0);
    p.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("schema migration: v1 → v2 idempotent, ALTER TABLE adds column", async () => {
    const dir = await tmpDir();
    const dbpath = path.join(dir, "learning.db");

    // Construct a v1-style DB by hand: nn_round_log without grad_norm_post_clip.
    {
      const raw = new Database(dbpath);
      raw.exec(`
        CREATE TABLE nn_round_log (
          round INTEGER NOT NULL,
          mode TEXT NOT NULL,
          outcome TEXT NOT NULL,
          loss REAL,
          grad_norm REAL,
          per_task_losses TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      raw
        .prepare(
          "INSERT INTO nn_round_log (round, mode, outcome, loss, grad_norm) VALUES (?, ?, ?, ?, ?)",
        )
        .run(99, "classic", "correct", 0.5, 2.0);
      raw.close();
    }

    // Reopen with LearningPersistence.open — should add the missing column
    // without dropping the existing v1 row.
    const p = await LearningPersistence.open({ dataDir: dir });
    const cols = p.rawDb
      .prepare("PRAGMA table_info(nn_round_log)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("grad_norm_post_clip");

    const row = p.rawDb
      .prepare("SELECT round, grad_norm, grad_norm_post_clip FROM nn_round_log WHERE round=99")
      .get() as { round: number; grad_norm: number; grad_norm_post_clip: number | null };
    expect(row.round).toBe(99);
    expect(row.grad_norm).toBeCloseTo(2.0);
    // Pre-existing row's new column is NULL after ALTER.
    expect(row.grad_norm_post_clip).toBeNull();

    // Idempotent: opening a second time must not throw or duplicate the column.
    p.close();
    const p2 = await LearningPersistence.open({ dataDir: dir });
    const cols2 = p2.rawDb
      .prepare("PRAGMA table_info(nn_round_log)")
      .all() as Array<{ name: string }>;
    expect(cols2.filter((c) => c.name === "grad_norm_post_clip")).toHaveLength(1);
    p2.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("pruneSnapshots keeps the latest N", async () => {
    const dir = await tmpDir();
    const p = await LearningPersistence.open({ dataDir: dir });
    for (let i = 1; i <= 5; i++) p.saveSnapshot(dummyPayload(i));
    p.pruneSnapshots(2);
    const c = p.rawDb.prepare("SELECT count(*) as c FROM nn_snapshots").get() as { c: number };
    expect(c.c).toBe(2);
    const latest = p.loadLatestSnapshot();
    expect(latest?.round).toBe(5);
    p.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
