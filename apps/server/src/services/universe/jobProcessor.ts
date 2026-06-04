/**
 * Enrichment job processor for Product Universe.
 *
 * Manages a SQLite-backed job queue that's polled via setInterval.
 * Jobs are dequeued by priority, executed with retry logic, and
 * dispatched to the appropriate enrichment function.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { PUJobType, PUJobStatus } from "@price-game/shared";
import type { AIProvider } from "../ai/types";
import { enrichMaterials, enrichSupplyChain, enrichCompany, enrichHistory } from "./enrichment";
import { computeSimilarity } from "./similarity";
import { computeGalaxyPositions } from "./galaxy";

/**
 * Queue a new enrichment job (idempotent — skips if a pending/running job exists).
 *
 * @param db - Database instance.
 * @param productId - Product to enrich (null for non-product jobs).
 * @param companyId - Company to enrich (null for non-company jobs).
 * @param jobType - Type of enrichment job.
 * @param priority - Job priority (higher = processed first, default 0).
 */
export function queueEnrichmentJob(
  db: DatabaseType,
  productId: number | null,
  companyId: number | null,
  jobType: PUJobType,
  priority: number = 0,
): void {
  // Check for existing pending/running job
  const existing = db.prepare(
    `SELECT id FROM pu_enrichment_jobs
     WHERE product_id IS ? AND company_id IS ? AND job_type = ? AND status IN ('pending', 'running')`
  ).get(productId, companyId, jobType);

  if (existing) return;

  db.prepare(
    `INSERT INTO pu_enrichment_jobs (product_id, company_id, job_type, status, priority)
     VALUES (?, ?, ?, 'pending', ?)`
  ).run(productId, companyId, jobType, priority);
}

/**
 * Process the next pending job from the queue.
 *
 * Dequeues the highest-priority pending job, marks it as running,
 * executes it, and updates the status accordingly.
 *
 * @param db - Database instance.
 * @param ai - AI provider for enrichment.
 * @param maxAttempts - Maximum retry attempts (default 3).
 * @returns True if a job was processed, false if queue is empty.
 */
export async function processNextJob(
  db: DatabaseType,
  ai: AIProvider,
  maxAttempts: number = 3,
): Promise<boolean> {
  // Atomic dequeue: SELECT + UPDATE in a transaction to prevent races
  const dequeue = db.transaction(() => {
    const row = db.prepare(
      `SELECT id, product_id, company_id, job_type, attempts
       FROM pu_enrichment_jobs
       WHERE status = 'pending' AND attempts < ?
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`
    ).get(maxAttempts) as {
      id: number;
      product_id: number | null;
      company_id: number | null;
      job_type: PUJobType;
      attempts: number;
    } | undefined;

    if (!row) return undefined;

    db.prepare(
      "UPDATE pu_enrichment_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ?"
    ).run(row.id);

    return { ...row, attempts: row.attempts + 1 };
  });

  const job = dequeue();
  if (!job) return false;

  try {
    switch (job.job_type) {
      case "enrich_materials":
        if (job.product_id) await enrichMaterials(db, ai, job.product_id);
        break;
      case "enrich_supply_chain":
        if (job.product_id) {
          await enrichSupplyChain(db, ai, job.product_id);
          // Chain: after supply chain, enrich history
          queueEnrichmentJob(db, job.product_id, null, "enrich_history");
        }
        break;
      case "enrich_history":
        if (job.product_id) {
          await enrichHistory(db, ai, job.product_id);
          // Chain: after history, compute similarity
          queueEnrichmentJob(db, job.product_id, null, "compute_similarity");
        }
        break;
      case "enrich_company":
        if (job.company_id) await enrichCompany(db, ai, job.company_id);
        break;
      case "compute_similarity":
        if (job.product_id) {
          computeSimilarity(db, job.product_id);
          computeGalaxyPositions(db);
        }
        break;
      default:
        break;
    }

    // Mark completed
    db.prepare(
      "UPDATE pu_enrichment_jobs SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
    ).run(job.id);

    // Chain: materials → supply chain
    if (job.job_type === "enrich_materials" && job.product_id) {
      queueEnrichmentJob(db, job.product_id, null, "enrich_supply_chain");
    }

    return true;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    const newStatus: PUJobStatus = job.attempts >= maxAttempts ? "failed" : "pending";
    db.prepare(
      "UPDATE pu_enrichment_jobs SET status = ?, last_error = ? WHERE id = ?"
    ).run(newStatus, errorMsg, job.id);

    console.error(`[PU] Job ${job.id} (${job.job_type}) failed:`, errorMsg);
    return true; // Still processed a job (even though it failed)
  }
}

/**
 * Get pending job count.
 *
 * @param db - Database instance.
 * @returns Number of pending jobs.
 */
export function getPendingJobCount(db: DatabaseType): number {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM pu_enrichment_jobs WHERE status = 'pending'"
  ).get() as { cnt: number };
  return row.cnt;
}

/**
 * Start the job processor interval.
 *
 * @param db - Database instance.
 * @param ai - AI provider.
 * @param intervalMs - Polling interval in ms (default 30000).
 * @param maxAttempts - Max retry attempts per job.
 * @returns The interval handle (for cleanup).
 */
export function startJobProcessor(
  db: DatabaseType,
  ai: AIProvider,
  intervalMs: number = 30000,
  maxAttempts: number = 3,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      await processNextJob(db, ai, maxAttempts);
    } catch (err) {
      console.error("[PU] Job processor error:", err);
    }
  }, intervalMs);
}
