/**
 * SQLite persistence for the streamer-bot learning system.
 *
 * Schema (v2):
 *   nn_snapshots(round PK) — one row per snapshot. weights, optimizer
 *     state, feature_norm, replay buffer, teaching moments, OOD blender
 *     all stored as BLOBs in a single transaction.
 *   nn_snapshots_archived — same shape; receives snapshots whose
 *     `arch_hash` no longer matches the current model spec, so they're
 *     not lost (and can be inspected manually). Created on first
 *     mismatch.
 *   nn_round_log — append-only per-round telemetry (loss, gradNorm,
 *     gradNormPostClip, mode, outcome). Bounded by NDJSON-side log
 *     rotation; this table keeps a compact row for fast SQL aggregation.
 *
 * v1 → v2 migration: adds `grad_norm_post_clip REAL` to nn_round_log so
 * the diagnostic signal can distinguish raw grad spikes (pre-clip) from
 * the unit-norm steps Adam actually applies (post-clip). Migration is
 * additive — existing rows retain NULL in the new column.
 *
 * Pragmas:
 *   journal_mode = WAL
 *   synchronous = NORMAL
 *   wal_autocheckpoint = 1000
 *
 * Manual `wal_checkpoint(TRUNCATE)` is run from the worker only when
 * `bridge.lastPredictAt > 2 s ago` — see `worker.ts`.
 */

import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { archHash as computeArchHash, DEFAULT_ARCH_HASH } from "./archHash";

/**
 * Bumped when on-disk schema changes — including changes to the
 * per-buffer layout of the `weights` BLOB.
 *
 *   v1 — initial.
 *   v2 — Phase 0 telemetry: nn_round_log gained `grad_norm_post_clip`.
 *        Buffer layout unchanged.
 *   v3 — Phase 3e.2: filmGen's input dim shrank 6 → 3 (mood cond slim).
 *        warmStart's prefix-copy must skip filmGen on this bump or it
 *        would write the OLD 6-column layout into the new 3-column
 *        buffer and scramble the surviving outputs. Trunk + priceClass
 *        dims unchanged so the first 6 buffers (trunk[0]+1 +
 *        priceClassHead) are still byte-compatible. SQL schema is
 *        identical to v2.
 */
export const SCHEMA_VERSION = 3;

export interface SnapshotPayload {
  round: number;
  /** Flattened network params (Float32Array → Buffer). */
  weights: Buffer;
  /** AdamW state. */
  optimizerState: Buffer;
  /** Normalizer state. */
  featureNorm: Buffer;
  /** Replay buffer dump. */
  replayBuffer: Buffer;
  /** Teaching moments dump. */
  teachingMoments: Buffer;
  /** OOD blender dump. */
  oodBlender: Buffer;
  /** Uncertainty weights. */
  uncertaintyWeights: Buffer;
}

export interface LoadedSnapshot extends SnapshotPayload {
  archHash: string;
  schemaVersion: number;
  createdAt: string;
}

export interface PersistenceOpenOpts {
  /** Where to put `learning.db`. Created if missing. */
  dataDir: string;
  /** Override arch hash (tests). Defaults to DEFAULT_ARCH_HASH. */
  archHashOverride?: string;
}

export class LearningPersistence {
  private db: DatabaseInstance;
  readonly archHash: string;

  private constructor(db: DatabaseInstance, archHash: string) {
    this.db = db;
    this.archHash = archHash;
  }

  /** Open or create the DB. Idempotent. */
  static async open(opts: PersistenceOpenOpts): Promise<LearningPersistence> {
    await fs.mkdir(opts.dataDir, { recursive: true });
    const dbpath = path.join(opts.dataDir, "learning.db");
    const db = new Database(dbpath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("wal_autocheckpoint = 1000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS nn_snapshots (
        round INTEGER PRIMARY KEY,
        arch_hash TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        weights BLOB NOT NULL,
        optimizer_state BLOB NOT NULL,
        feature_norm BLOB NOT NULL,
        replay_buffer BLOB NOT NULL,
        teaching_moments BLOB NOT NULL,
        ood_blender BLOB NOT NULL,
        uncertainty_weights BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS nn_round_log (
        round INTEGER NOT NULL,
        mode TEXT NOT NULL,
        outcome TEXT NOT NULL,
        loss REAL,
        grad_norm REAL,
        grad_norm_post_clip REAL,
        per_task_losses TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_round_log_round ON nn_round_log(round);
    `);
    // v1 → v2 migration: pre-existing v1 DBs predate `grad_norm_post_clip`.
    // CREATE TABLE IF NOT EXISTS above is a no-op on v1 dbs (the table
    // exists), so we have to ALTER explicitly. SQLite has no idempotent
    // ALTER, so probe via PRAGMA before adding.
    const cols = db
      .prepare("PRAGMA table_info(nn_round_log)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "grad_norm_post_clip")) {
      db.exec("ALTER TABLE nn_round_log ADD COLUMN grad_norm_post_clip REAL");
    }
    return new LearningPersistence(db, opts.archHashOverride ?? DEFAULT_ARCH_HASH);
  }

  /**
   * Insert a snapshot at `round`. Replaces any prior row at that round.
   * Wrapped in a single transaction.
   */
  saveSnapshot(payload: SnapshotPayload): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO nn_snapshots
        (round, arch_hash, schema_version, weights, optimizer_state, feature_norm,
         replay_buffer, teaching_moments, ood_blender, uncertainty_weights, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    const tx = this.db.transaction((p: SnapshotPayload) => {
      stmt.run(
        p.round,
        this.archHash,
        SCHEMA_VERSION,
        p.weights,
        p.optimizerState,
        p.featureNorm,
        p.replayBuffer,
        p.teachingMoments,
        p.oodBlender,
        p.uncertaintyWeights,
      );
    });
    tx(payload);
  }

  /**
   * Load the most recent snapshot whose `arch_hash` matches our current
   * spec. When mismatch detected, archive everything (move to
   * `nn_snapshots_archived`) and return null. When no rows at all,
   * return null without archiving.
   */
  loadLatestSnapshot(): LoadedSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT round, arch_hash, schema_version, weights, optimizer_state, feature_norm,
                replay_buffer, teaching_moments, ood_blender, uncertainty_weights, created_at
         FROM nn_snapshots ORDER BY round DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.arch_hash !== this.archHash) {
      this.archiveAll();
      return null;
    }
    return {
      round: row.round as number,
      archHash: row.arch_hash as string,
      schemaVersion: row.schema_version as number,
      weights: row.weights as Buffer,
      optimizerState: row.optimizer_state as Buffer,
      featureNorm: row.feature_norm as Buffer,
      replayBuffer: row.replay_buffer as Buffer,
      teachingMoments: row.teaching_moments as Buffer,
      oodBlender: row.ood_blender as Buffer,
      uncertaintyWeights: row.uncertainty_weights as Buffer,
      createdAt: row.created_at as string,
    };
  }

  /**
   * Phase 3b: read the most-recent row from `nn_snapshots_archived`.
   * Returns null when the archive table doesn't exist or is empty.
   * Used by the warm-start path to seed the new arch's compatible
   * buffers (trunk + priceClassHead + filmGen) from the previous
   * arch's weights, cushioning the reset.
   */
  loadLatestArchivedSnapshot(): LoadedSnapshot | null {
    // Probe whether the archive table exists. If it doesn't (no
    // archHash mismatch ever happened on this DB), there's nothing
    // to warm-start from.
    const tbl = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='nn_snapshots_archived'`,
      )
      .get();
    if (!tbl) return null;
    const row = this.db
      .prepare(
        `SELECT round, arch_hash, schema_version, weights, optimizer_state, feature_norm,
                replay_buffer, teaching_moments, ood_blender, uncertainty_weights, created_at
         FROM nn_snapshots_archived ORDER BY round DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      round: row.round as number,
      archHash: row.arch_hash as string,
      schemaVersion: row.schema_version as number,
      weights: row.weights as Buffer,
      optimizerState: row.optimizer_state as Buffer,
      featureNorm: row.feature_norm as Buffer,
      replayBuffer: row.replay_buffer as Buffer,
      teachingMoments: row.teaching_moments as Buffer,
      oodBlender: row.ood_blender as Buffer,
      uncertaintyWeights: row.uncertainty_weights as Buffer,
      createdAt: row.created_at as string,
    };
  }

  /**
   * Move every row from `nn_snapshots` to `nn_snapshots_archived`.
   * Used when archHash mismatches.
   */
  archiveAll(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nn_snapshots_archived AS SELECT * FROM nn_snapshots WHERE 0;
    `);
    this.db.exec(`INSERT INTO nn_snapshots_archived SELECT * FROM nn_snapshots`);
    this.db.exec(`DELETE FROM nn_snapshots`);
  }

  /**
   * Append a per-round log row.
   *
   * `gradNorm` is the pre-clip global L2 norm (raw backward signal).
   * `gradNormPostClip` is the norm Adam actually applies; equal to
   * `min(gradNorm, MAX_GRAD_NORM)` analytically. Logged separately so
   * we can distinguish "loss surface produced a noisy gradient" from
   * "Adam took a destabilising step." Both are nullable for tests and
   * for v1 rows that pre-date the column.
   */
  logRound(row: {
    round: number;
    mode: string;
    outcome: string;
    loss: number | null;
    gradNorm: number | null;
    gradNormPostClip?: number | null;
    perTaskLosses?: number[] | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO nn_round_log (round, mode, outcome, loss, grad_norm, grad_norm_post_clip, per_task_losses)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.round,
        row.mode,
        row.outcome,
        row.loss,
        row.gradNorm,
        row.gradNormPostClip ?? null,
        row.perTaskLosses ? JSON.stringify(row.perTaskLosses) : null,
      );
  }

  /**
   * Drop the oldest snapshots, keeping at most `keep`. Idempotent —
   * called after each successful saveSnapshot.
   */
  pruneSnapshots(keep: number): void {
    this.db
      .prepare(
        `DELETE FROM nn_snapshots WHERE round NOT IN (
           SELECT round FROM nn_snapshots ORDER BY round DESC LIMIT ?
         )`,
      )
      .run(keep);
  }

  /**
   * Drop nn_round_log rows older than `days`. Without this the table
   * grows unbounded — at 5 rounds/min × 24 h that's ~7,200 rows/day,
   * ~2.6 M rows/year — even though docs claim it's "bounded by NDJSON
   * rotation" (which is a separate, file-based logger).
   *
   * @param days Rows older than this many days are deleted.
   */
  pruneRoundLog(days: number): void {
    this.db
      .prepare(`DELETE FROM nn_round_log WHERE created_at < datetime('now', ?)`)
      .run(`-${days} days`);
  }

  /** Wal_checkpoint(TRUNCATE) — should only be called when idle. */
  walCheckpointTruncate(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* idempotent */
    }
  }

  /** Tests-only — exposes the underlying handle. */
  get rawDb(): DatabaseInstance {
    return this.db;
  }
}

/** Compute and re-export the current arch hash for the worker init handshake. */
export const CURRENT_ARCH_HASH = computeArchHash();
