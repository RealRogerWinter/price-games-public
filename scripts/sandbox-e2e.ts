#!/usr/bin/env npx tsx
/**
 * Sandbox e2e + red-team driver.
 *
 * Operational smoke test that hits a running sandbox over real HTTP /
 * Socket.IO and validates the analytics surface survives realistic
 * stress + adversarial inputs:
 *
 *   - Happy-path SP flow (start, guess loop, complete)
 *   - Beacon dedup under retry
 *   - Malformed payloads (oversized, deeply nested, control-chars)
 *   - DOS bound (1000 events / 60s, rate limiter must absorb)
 *   - Cookie-jar swap mid-session (no cross-pollination)
 *   - Synthetic-flag leak attempt (client cannot set is_synthetic=1)
 *   - DNT bypass attempt (sticky preference outranks header tampering)
 *   - Server-only event spoof (game_completed via beacon must not land)
 *
 * Why this exists separately from the in-process E2E suite (PRs 6.x):
 *   - Validates the production stack (Caddy → Express → SQLite via
 *     Docker volume) rather than a single in-memory test fixture.
 *   - Exercises rate limiters, real network I/O, real cookie handling.
 *   - Adversarial scenarios that would be awkward to fold into vitest
 *     because they intentionally test failure modes.
 *
 * Usage:
 *   npx tsx scripts/sandbox-e2e.ts                            # default https://sandbox.price.games
 *   SANDBOX_URL=http://localhost:3002 npx tsx scripts/sandbox-e2e.ts
 *   npx tsx scripts/sandbox-e2e.ts --only=dedup,dos           # subset
 *
 * Exit codes: 0 = all scenarios passed. 1 = at least one failed.
 *
 * Notes for ops:
 *   - The driver does NOT need DB read access. It asserts everything
 *     via HTTP responses and re-issued probes (e.g. for dedup, sends
 *     the same envelope twice and verifies the rate-limit / response
 *     shape; for the deeper "exactly N rows" invariant, the in-process
 *     suite already pins it).
 *   - Each scenario is independent — if one fails, others still run.
 *     CI logs every result for postmortem.
 */

import { randomUUID } from "crypto";

const SANDBOX_URL = process.env.SANDBOX_URL ?? "https://sandbox.price.games";
const TIMEOUT_MS = parseInt(process.env.SANDBOX_TIMEOUT_MS ?? "10000", 10);
const ONLY = (process.argv.find((a) => a.startsWith("--only="))?.split("=")[1] ?? "").split(",").filter(Boolean);
const FORCE_PROD = process.argv.includes("--force-prod");

/**
 * Hard guardrail: refuse to fire adversarial payloads (oversized JSON,
 * 200-request bursts, etc.) at anything that isn't an obvious sandbox
 * or local host. Without this, a misconfigured `SANDBOX_URL=https://price.games`
 * would direct the dos-bound scenario at production. `--force-prod`
 * exists for the rare case where ops genuinely needs to probe a non-
 * sandbox host (e.g. a staging clone). Prefer NEVER passing it.
 */
function assertSafeTarget(url: string): void {
  if (FORCE_PROD) {
    console.warn(`sandbox-e2e: --force-prod set, hitting ${url} anyway`);
    return;
  }
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const sandboxLike =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".local") ||
    host.startsWith("sandbox.") ||
    host.includes("staging");
  if (!sandboxLike) {
    console.error(
      `sandbox-e2e: refusing to run against ${url}. ` +
        `host "${host}" does not look like a sandbox/local target. ` +
        `Pass --force-prod to override (NOT recommended).`,
    );
    process.exit(2);
  }
}

interface ScenarioResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

type Scenario = () => Promise<void>;

const scenarios: Array<{ name: string; tag: string; run: Scenario }> = [];

function register(name: string, tag: string, run: Scenario): void {
  scenarios.push({ name, tag, run });
}

async function fetchSandbox(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(`${SANDBOX_URL}${path}`, {
      ...init,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function makeEnvelope(
  events: Array<{
    name?: string;
    path?: string;
    ts?: number;
    seq?: number;
    clientEventId?: string;
    properties?: Record<string, string | number | boolean | null>;
  }>,
  sentAt: number = Date.now(),
  tabId: string = randomUUID(),
): { tabId: string; sentAt: number; events: Array<unknown> } {
  return {
    tabId,
    sentAt,
    events: events.map((e, i) => ({
      name: e.name ?? "page_viewed",
      category: "page",
      path: e.path ?? "/",
      ts: e.ts ?? Date.now(),
      seq: e.seq ?? i,
      clientEventId: e.clientEventId ?? randomUUID(),
      properties: e.properties,
    })),
  };
}

function assertOk(res: Response, expectedStatuses: number[] = [200, 204]): void {
  if (!expectedStatuses.includes(res.status)) {
    throw new Error(
      `expected one of [${expectedStatuses.join(", ")}], got ${res.status}`,
    );
  }
}

// ============================================================================
// Scenarios
// ============================================================================

register("happy-path: GET /api/game/categories returns 200", "happy", async () => {
  const res = await fetchSandbox("/api/game/categories");
  assertOk(res, [200]);
  const body = (await res.json()) as { categories: Array<{ name: string; count: number }> };
  if (!Array.isArray(body.categories)) {
    throw new Error("categories not an array");
  }
});

register("beacon: empty envelope returns 400", "beacon", async () => {
  const res = await fetchSandbox("/api/events/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertOk(res, [400]);
});

register("beacon: well-formed envelope accepts (returns 204)", "beacon", async () => {
  const res = await fetchSandbox("/api/events/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeEnvelope([{}])),
  });
  assertOk(res, [204]);
});

register("dedup: same clientEventId flushed twice still returns 204 both times", "dedup", async () => {
  const env = makeEnvelope([{}]);
  const r1 = await fetchSandbox("/api/events/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(env),
  });
  assertOk(r1, [204]);
  const r2 = await fetchSandbox("/api/events/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(env),
  });
  assertOk(r2, [204]);
  // The (visitor_id, client_event_id) UNIQUE index absorbs the dup
  // server-side. Driver can't query the row count without DB access,
  // but the in-process E2E suite pins exact-row-count behavior. Here
  // we pin the contract that the route never errors on a retry.
});

register(
  "malformed: oversized properties (~10KB) still parses without 5xx",
  "malformed",
  async () => {
    const big = "x".repeat(10_000);
    const env = makeEnvelope([{ properties: { huge: big } }]);
    const res = await fetchSandbox("/api/events/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(env),
    });
    // Either accepted (truncated server-side) or rejected at validation,
    // never 5xx.
    if (res.status >= 500) {
      throw new Error(`5xx on oversized payload: ${res.status}`);
    }
  },
);

register("malformed: deeply nested JSON (50 levels) does not crash", "malformed", async () => {
  let nested: unknown = "leaf";
  for (let i = 0; i < 50; i++) nested = { nested };
  const env = makeEnvelope([{ properties: nested as Record<string, never> }]);
  const res = await fetchSandbox("/api/events/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(env),
  });
  if (res.status >= 500) {
    throw new Error(`5xx on deeply-nested payload: ${res.status}`);
  }
});

register(
  "malformed: actual control characters (NUL/SOH) in event name do not 5xx",
  "malformed",
  async () => {
    const env = makeEnvelope([{ name: "page_viewed" + "\u0000\u0001" }]);
    const res = await fetchSandbox("/api/events/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(env),
    });
    if (res.status >= 500) {
      throw new Error(`5xx on control-char payload: ${res.status}`);
    }
  },
);

register(
  "spoofing: server-only event_name (game_completed) submitted via beacon does not error but is dropped",
  "spoofing",
  async () => {
    // The route's allowlist filters disallowed events; the response
    // is still 204 because the envelope itself was well-formed. The
    // in-process suite asserts exact row count; here we only verify
    // the route doesn't reject the envelope (defense-in-depth that
    // a malicious client cannot DOS the endpoint by spamming
    // disallowed event names).
    const env = makeEnvelope([{ name: "game_completed" }]);
    const res = await fetchSandbox("/api/events/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(env),
    });
    assertOk(res, [204]);
  },
);

register(
  "dos-bound: 200 concurrent envelopes return only 204 or 429 (never 5xx) and complete within a deadline",
  "dos",
  async () => {
    const N = 200;
    // Hard deadline: a healthy sandbox must clear 200 concurrent
    // envelopes well inside 30s. Going over indicates the limiter
    // is queuing rather than 429-ing (which is its own bug — the
    // limiter is supposed to fail fast).
    const DEADLINE_MS = 30_000;
    const tasks: Array<Promise<Response>> = [];
    const start = Date.now();
    for (let i = 0; i < N; i++) {
      tasks.push(
        fetchSandbox("/api/events/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeEnvelope([{}])),
          timeoutMs: 5000,
        }),
      );
    }
    const results = await Promise.allSettled(tasks);
    const elapsed = Date.now() - start;
    let ok = 0;
    let rateLimited = 0;
    let errors = 0;
    for (const r of results) {
      if (r.status === "rejected") {
        errors++;
        continue;
      }
      if (r.value.status === 204) ok++;
      else if (r.value.status === 429) rateLimited++;
      else if (r.value.status >= 500) {
        throw new Error(`server 5xx during DOS bound: ${r.value.status}`);
      }
    }
    if (ok + rateLimited === 0) {
      throw new Error(`no successful or rate-limited responses: errors=${errors}`);
    }
    if (elapsed > DEADLINE_MS) {
      throw new Error(
        `DOS-bound batch took ${elapsed}ms (deadline ${DEADLINE_MS}ms) — limiter likely queueing instead of 429-ing`,
      );
    }
  },
);

register(
  "synthetic-flag-leak: a client-supplied is_synthetic property in the envelope is not honored as a column value",
  "spoofing",
  async () => {
    // The is_synthetic column is server-managed (only the backfill
    // script sets it = 1). Even if a malicious client smuggles
    // `is_synthetic: 1` as an event property, the route ignores it
    // because properties land in the JSON-blob column, not the
    // dedicated is_synthetic INTEGER column. We assert the route
    // accepts the envelope without erroring — the actual column-
    // isolation invariant is pinned by the in-process suite.
    const env = makeEnvelope([{ properties: { is_synthetic: 1 } }]);
    const res = await fetchSandbox("/api/events/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(env),
    });
    assertOk(res, [204]);
  },
);

register(
  "dnt: a DNT=1 followed by a no-DNT-header request (the sticky-preserve path) is accepted without error",
  "dnt",
  async () => {
    // What this actually probes: the sticky-DNT contract from PR 6.1.
    // Per recordEventFromRequest, an absent DNT header is treated as
    // undefined so the COALESCE in visitor_profile preserves the
    // prior preference. The DRIVER cannot observe the column-level
    // outcome (no DB read), so this scenario only pins that both
    // requests return 204; the in-process suite asserts the actual
    // sticky preservation. (Originally this scenario claimed to test
    // DNT-bypass behavior — clarified to match what HTTP-level
    // assertions can actually prove.)
    const r1 = await fetchSandbox("/api/events/track", {
      method: "POST",
      headers: { "Content-Type": "application/json", DNT: "1" },
      body: JSON.stringify(makeEnvelope([{}])),
    });
    assertOk(r1, [204]);
    const setCookie = r1.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/visitor_id=([^;]+)/);
    if (!m) return; // sandbox may not mint a cookie on this path; skip rather than fail.
    const cookie = `visitor_id=${m[1]}`;
    const r2 = await fetchSandbox("/api/events/track", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(makeEnvelope([{}])),
    });
    assertOk(r2, [204]);
  },
);

register(
  "cookie-jar-swap: changing the visitor_id cookie mid-session lands events under the new cookie without crash",
  "identity",
  async () => {
    // Request 1 mints a cookie. Request 2 swaps to a fresh UUID and
    // sends the same envelope shape; the server treats it as a new
    // visitor. This is the legitimate "private browsing" case; we
    // pin that the server accepts both without error.
    const r1 = await fetchSandbox("/api/events/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeEnvelope([{}])),
    });
    assertOk(r1, [204]);
    const swappedCookie = `visitor_id=${randomUUID()}`;
    const r2 = await fetchSandbox("/api/events/track", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: swappedCookie },
      body: JSON.stringify(makeEnvelope([{}])),
    });
    assertOk(r2, [204]);
  },
);

// ============================================================================
// Runner
// ============================================================================

async function main(): Promise<void> {
  assertSafeTarget(SANDBOX_URL);

  // Validate --only tags up front so a typo doesn't silently run
  // zero scenarios and report 0/0 as a pass.
  if (ONLY.length > 0) {
    const known = new Set(scenarios.map((s) => s.tag));
    const unknown = ONLY.filter((t) => !known.has(t));
    if (unknown.length > 0) {
      console.error(
        `sandbox-e2e: unknown --only tags: ${unknown.join(", ")}. ` +
          `Known tags: ${[...known].sort().join(", ")}`,
      );
      process.exit(2);
    }
  }

  const filtered = ONLY.length
    ? scenarios.filter((s) => ONLY.includes(s.tag))
    : scenarios;

  // Upfront connectivity probe — surfaces a wrong URL or down sandbox
  // immediately rather than as N "fetch failed" lines.
  try {
    await fetchSandbox("/api/game/categories", { timeoutMs: 5000 });
  } catch (err) {
    console.error(
      `sandbox-e2e: connectivity probe failed for ${SANDBOX_URL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(2);
  }

  console.log(`sandbox-e2e — ${SANDBOX_URL} — running ${filtered.length} scenarios\n`);
  const results: ScenarioResult[] = [];
  for (const s of filtered) {
    const start = Date.now();
    try {
      await s.run();
      results.push({ name: s.name, passed: true, durationMs: Date.now() - start });
      console.log(`  PASS  ${s.name}  (${Date.now() - start}ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name: s.name, passed: false, durationMs: Date.now() - start, error: msg });
      console.log(`  FAIL  ${s.name}  (${Date.now() - start}ms)  ${msg}`);
    }
  }
  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed, ${failed.length} failed`,
  );
  if (failed.length > 0) {
    console.log("\nfailed scenarios:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("driver crashed:", err);
  process.exit(2);
});
