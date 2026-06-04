/**
 * Admin leaderboard management REST API.
 *
 * Mounted at `/api/admin/leaderboard` from `apps/server/src/index.ts`.
 * All routes require an authenticated admin session with 2FA enrolled —
 * same gate as the rest of the admin API. The factory takes an optional
 * Database injection so tests can supply an in-memory db without loading
 * the production module.
 */
import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import { VALID_GAME_MODES } from "@price-game/shared";
import { requireAdmin, require2faEnrolled, setDb as setMiddlewareDb } from "../middleware/adminAuth";
import {
  listEntries,
  excludeEntry,
  restoreEntry,
  bulkExcludeEntries,
  getUserSummary,
  banUser,
  unbanUser,
  banUserHistory,
  setTestAccountFlag,
  listBannedUsers,
  listAuditLog,
  getStats,
} from "../services/adminLeaderboard";

/** Upper bound on free-text reason strings (DB has no length cap, so we
 * enforce one at the route boundary to stop a single 1MB-reason payload
 * from poisoning the audit log). */
const MAX_REASON_LENGTH = 500;

/** Cap on `durationDays` for timed bans — 10 years is more than long
 * enough that anything bigger is a bug or a typo. */
const MAX_BAN_DURATION_DAYS = 3650;

/** Cap on bulk-exclude batch size. Above this the UI almost certainly
 * wants a saved-search/cohort flow, not a one-shot bulk action. */
const MAX_BULK_IDS = 500;

/**
 * Coerce a query-string number into a finite number or undefined.
 * Returns undefined for missing/empty/non-numeric input so handlers can
 * forward the value to a service that already applies defaults.
 */
function parseNum(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Strict positive-integer parser for path / body ids — rejects 0,
 * negatives, fractions, NaN, and non-numeric strings. Use this instead
 * of `parseNum` for db row ids: `Number(null)` → 0 and `Number(true)` → 1
 * would otherwise silently coerce to "valid" ids.
 */
function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/** Coerce a reason field, enforcing the max-length cap. */
function parseReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.length > MAX_REASON_LENGTH) return undefined;
  return raw;
}

/**
 * Pull the admin actor identity from `req.adminUser` populated by
 * `requireAdmin`. Throws if not present — callers must mount this
 * router behind `requireAdmin`.
 */
function actorFromReq(req: Request): { id: string; username: string } {
  if (!req.adminUser) {
    throw new Error("requireAdmin middleware did not populate req.adminUser");
  }
  return { id: req.adminUser.id, username: req.adminUser.username };
}

/**
 * Build the admin leaderboard router.
 *
 * @param db - Optional database injection for tests. When provided, the
 *   shared `requireAdmin` middleware is also wired against it.
 * @returns Configured Express router.
 */
export function createAdminLeaderboardRouter(db?: DatabaseType): Router {
  const router = Router();

  // Lazy-loaded production db; tests pass `db` directly into every handler.
  let resolvedDb: DatabaseType | null = db ?? null;
  if (db) setMiddlewareDb(db);
  const getDb = (): DatabaseType => {
    if (resolvedDb) return resolvedDb;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    resolvedDb = require("../db").default as DatabaseType;
    return resolvedDb!;
  };

  // ─── Stats ─────────────────────────────────────────────────────────────
  router.get("/stats", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    res.json(getStats(getDb()));
  });

  // ─── Entries ──────────────────────────────────────────────────────────
  router.get("/entries", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const status = (req.query.status as string | undefined) ?? "all";
    // Validate mode against the allowlist — same convention as the public
    // /api/leaderboard route — so unknown modes return an empty result
    // rather than letting a typo bypass the allowlist.
    const rawMode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    if (rawMode && !VALID_GAME_MODES.has(rawMode)) {
      res.json({ entries: [], total: 0, limit: 0, offset: 0 });
      return;
    }
    const result = listEntries(getDb(), {
      mode: rawMode,
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      scoreMin: parseNum(req.query.scoreMin),
      scoreMax: parseNum(req.query.scoreMax),
      dateFrom: typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined,
      dateTo: typeof req.query.dateTo === "string" ? req.query.dateTo : undefined,
      status: status === "active" || status === "excluded" ? status : "all",
      limit: parseNum(req.query.limit),
      offset: parseNum(req.query.offset),
      sort: req.query.sort === "playedAt" ? "playedAt" : "score",
      direction: req.query.direction === "asc" ? "asc" : "desc",
    });
    res.json(result);
  });

  router.post(
    "/entries/:id/exclude",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) {
        res.status(400).json({ error: "Invalid entry id" });
        return;
      }
      const reason = parseReason(req.body?.reason);
      if (reason === undefined) {
        res.status(400).json({ error: `Reason is required (max ${MAX_REASON_LENGTH} chars)` });
        return;
      }
      try {
        const updated = excludeEntry(getDb(), id, actorFromReq(req), reason);
        if (!updated) {
          res.status(404).json({ error: "Entry not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Bad request" });
      }
    },
  );

  router.post(
    "/entries/:id/restore",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const id = parsePositiveInt(req.params.id);
      if (id === undefined) {
        res.status(400).json({ error: "Invalid entry id" });
        return;
      }
      const rawReason = req.body?.reason;
      if (rawReason !== undefined && parseReason(rawReason) === undefined) {
        res.status(400).json({ error: `Reason must be a string up to ${MAX_REASON_LENGTH} chars` });
        return;
      }
      const reason = parseReason(rawReason);
      const updated = restoreEntry(getDb(), id, actorFromReq(req), reason);
      if (!updated) {
        res.status(404).json({ error: "Entry not found" });
        return;
      }
      res.json(updated);
    },
  );

  router.post(
    "/entries/bulk-exclude",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
      const reason = parseReason(req.body?.reason);
      if (!ids || ids.length === 0) {
        res.status(400).json({ error: "ids must be a non-empty array" });
        return;
      }
      if (ids.length > MAX_BULK_IDS) {
        res.status(400).json({ error: `Too many ids (max ${MAX_BULK_IDS} per request)` });
        return;
      }
      if (reason === undefined) {
        res.status(400).json({ error: `Reason is required (max ${MAX_REASON_LENGTH} chars)` });
        return;
      }
      const intIds: number[] = [];
      for (const raw of ids) {
        const n = parsePositiveInt(raw);
        if (n === undefined) {
          res.status(400).json({ error: "All ids must be positive integers" });
          return;
        }
        intIds.push(n);
      }
      try {
        const result = bulkExcludeEntries(getDb(), intIds, actorFromReq(req), reason);
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Bad request" });
      }
    },
  );

  // ─── Users (drilldown + ban + test flag) ──────────────────────────────
  router.get(
    "/users/:userId",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const summary = getUserSummary(getDb(), String(req.params.userId));
      if (!summary) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json(summary);
    },
  );

  router.post(
    "/users/:userId/ban",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const reason = parseReason(req.body?.reason);
      if (reason === undefined) {
        res.status(400).json({ error: `Reason is required (max ${MAX_REASON_LENGTH} chars)` });
        return;
      }
      const durationDays = parseNum(req.body?.durationDays);
      if (durationDays !== undefined) {
        if (durationDays <= 0 || durationDays > MAX_BAN_DURATION_DAYS) {
          res.status(400).json({
            error: `durationDays must be between 1 and ${MAX_BAN_DURATION_DAYS}`,
          });
          return;
        }
      }
      try {
        const summary = banUser(getDb(), String(req.params.userId), actorFromReq(req), {
          reason,
          durationDays,
        });
        if (!summary) {
          res.status(404).json({ error: "User not found" });
          return;
        }
        res.json(summary);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Bad request" });
      }
    },
  );

  router.post(
    "/users/:userId/ban-history",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const reason = parseReason(req.body?.reason);
      if (reason === undefined) {
        res.status(400).json({ error: `Reason is required (max ${MAX_REASON_LENGTH} chars)` });
        return;
      }
      const durationDays = parseNum(req.body?.durationDays);
      if (durationDays !== undefined) {
        if (durationDays <= 0 || durationDays > MAX_BAN_DURATION_DAYS) {
          res.status(400).json({
            error: `durationDays must be between 1 and ${MAX_BAN_DURATION_DAYS}`,
          });
          return;
        }
      }
      try {
        const summary = banUserHistory(getDb(), String(req.params.userId), actorFromReq(req), {
          reason,
          durationDays,
        });
        if (!summary) {
          res.status(404).json({ error: "User not found" });
          return;
        }
        res.json(summary);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Bad request" });
      }
    },
  );

  router.post(
    "/users/:userId/unban",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const rawReason = req.body?.reason;
      if (rawReason !== undefined && parseReason(rawReason) === undefined) {
        res.status(400).json({ error: `Reason must be a string up to ${MAX_REASON_LENGTH} chars` });
        return;
      }
      const reason = parseReason(rawReason);
      const summary = unbanUser(getDb(), String(req.params.userId), actorFromReq(req), reason);
      if (!summary) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json(summary);
    },
  );

  router.post(
    "/users/:userId/test-flag",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const isTest = req.body?.isTest === true || req.body?.isTest === "true";
      const summary = setTestAccountFlag(
        getDb(),
        String(req.params.userId),
        isTest,
        actorFromReq(req),
      );
      if (!summary) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json(summary);
    },
  );

  // ─── Banned accounts list ─────────────────────────────────────────────
  router.get("/banned", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const result = listBannedUsers(getDb(), {
      limit: parseNum(req.query.limit),
      offset: parseNum(req.query.offset),
    });
    res.json(result);
  });

  // ─── Audit log ────────────────────────────────────────────────────────
  router.get("/audit", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const targetType = req.query.targetType;
    const result = listAuditLog(getDb(), {
      limit: parseNum(req.query.limit),
      offset: parseNum(req.query.offset),
      action: typeof req.query.action === "string" ? req.query.action : undefined,
      targetType:
        targetType === "entry" || targetType === "user" ? targetType : undefined,
      targetId: typeof req.query.targetId === "string" ? req.query.targetId : undefined,
    });
    res.json(result);
  });

  return router;
}
