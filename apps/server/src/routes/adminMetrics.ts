/**
 * Slim runtime-metrics endpoint exposed to authenticated admins.
 *
 * Kept from the PR1 phase-1 perf instrumentation as the one piece worth
 * leaving on permanently: a low-overhead read of process memory, event-
 * loop lag percentiles, connected-socket count, and uptime. Lets the
 * admin dashboard surface "is the server healthy?" without a separate
 * observability stack.
 *
 * The full SQL/request/socket-event timing harness lives only behind
 * `PERF_PROFILE=1` and is not part of normal operation.
 */

import { Router, Request, Response } from "express";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import type { Server as IoServer } from "socket.io";
import { requireAdmin, require2faEnrolled } from "../middleware/adminAuth";

let elDelay: IntervalHistogram | null = null;
function getElDelay(): IntervalHistogram {
  if (elDelay === null) {
    elDelay = monitorEventLoopDelay({ resolution: 10 });
    elDelay.enable();
  }
  return elDelay;
}

/**
 * Build the admin-only metrics router. Caller passes the live Socket.IO
 * server so `socketsConnected` reflects reality without us reaching into
 * a global.
 */
export function createAdminMetricsRouter(io: IoServer): Router {
  const router = Router();

  // PR3 sec review followup: chain `require2faEnrolled` after
  // `requireAdmin` so this endpoint matches the 2FA invariant every
  // other admin data route holds (admin.ts, adminLeaderboard.ts,
  // adminGallery.ts, adminEmail.ts, adminNotifications.ts). Without
  // this an admin who logged in with cookie + has 2FA disabled would
  // see process.pid, node version, heap/CPU telemetry, and
  // connected-socket count — small but still a leak the rest of the
  // admin surface explicitly gates on TOTP enrollment.
  router.get("/", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const hist = getElDelay();
    const payload = {
      uptimeSec: Math.round(performance.now() / 100) / 10,
      memory: {
        rssMb: round(mem.rss / 1024 / 1024),
        heapUsedMb: round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: round(mem.heapTotal / 1024 / 1024),
        externalMb: round(mem.external / 1024 / 1024),
      },
      cpu: {
        userMs: Math.round(cpu.user / 1000),
        systemMs: Math.round(cpu.system / 1000),
      },
      eventLoopLagMs: {
        // perf_hooks histogram values are in nanoseconds.
        p50: round(hist.percentile(50) / 1e6),
        p99: round(hist.percentile(99) / 1e6),
        max: round(hist.max / 1e6),
      },
      socketsConnected: io.engine?.clientsCount ?? 0,
      pid: process.pid,
      nodeVersion: process.version,
    };
    // Reset the lag histogram each call so the percentiles describe the
    // *recent* window rather than process lifetime — matches what an
    // operator scraping the endpoint expects to see.
    hist.reset();
    res.json(payload);
  });

  return router;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
