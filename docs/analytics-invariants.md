---
title: Analytics Invariants
status: stable
last_reviewed: 2026-06-03
owner: growth
audience: contributor
category: analytics
summary: Invariants the analytics pipeline must uphold; how to add a new event safely.
related_code:
  - apps/server/src/routes
---
# Analytics Invariants

The analytics pipeline (client beacon → recordEvent → analytics_sessions → analytics_hourly → V2 dashboard) is the single most thoroughly tested surface in this repo. Every dashboard query depends on the seven invariants documented here. Each is enforced by at least one test that fails CI if the property is broken.

If you change anything in the analytics surface — a route, a service, a migration, a query — and one of these tests fails, **stop**. The invariant you broke is load-bearing for at least one dashboard's correctness.

## 1. Conservation

> For any window W, the count of game-completion events in `events` (where `is_bot = 0` and `is_synthetic = 0`) equals the sum of `games_completed` across `analytics_hourly` rows in W.

**Why it matters:** every "how many games?" dashboard reads `analytics_hourly`. If the rollup loses or doubles events, the dashboard reports the wrong number with no way for the user to detect it.

**Enforced by:**
- `apps/server/src/integration/analyticsE2E.invariants.test.ts` — property-based: any 0..3 SP completions + 0..5 page-views + rollup ⇒ events count == hourly sum
- `apps/server/src/integration/analyticsE2E.sp.test.ts` — point-tested: anon happy-path conservation
- `apps/server/src/test/analyticsScenario.ts:readConservationCounters` — exposed for any test to assert

## 2. Monotonicity

> For any visitor V, `gamesStarted(V) >= gamesCompleted(V)`.

**Why it matters:** a completion without a corresponding start indicates a missed emission upstream of `game_completed`. Silently violates funnel math (completion-rate > 100%).

**Enforced by:**
- `apps/server/src/test/analyticsScenario.ts:assertGlobalInvariants` — runs in every E2E test's `afterEach`
- `apps/server/src/integration/analyticsE2E.invariants.test.ts` — property-based across random visitor counts

## 3. Dedup-key integrity

> No two events share `(visitor_id, client_event_id)`.

**Why it matters:** the production UNIQUE partial index absorbs duplicate writes silently — duplicates only surface when re-inserting the same key. Pinning this property post-flow catches keying bugs — an earlier implementation had a duplicate-keying bug for MP completions before the index was introduced.

**Enforced by:**
- `apps/server/src/test/analyticsScenario.ts:assertGlobalInvariants` — afterEach
- `apps/server/src/integration/analyticsE2E.dedup.test.ts` — 7 dedup edge-cases including localStorage replay, network interruption, mixed batches
- `apps/server/src/services/recordEventCallsites.test.ts` — lint-style guard: every server-emitted event must have a deterministic `clientEventId` or be on the explicit allowlist

## 4. Rollup idempotency

> `rebuildHourlyRange([t1, t2])` over a frozen `events` table produces byte-identical `analytics_hourly` rows on repeated invocation.

**Why it matters:** the rollup is a DELETE-then-aggregate. If aggregation is non-deterministic (random order, time-of-day in WHERE clauses), running it twice produces different rows and dashboards drift between page-loads.

**Enforced by:**
- `apps/server/src/integration/analyticsE2E.invariants.test.ts` — pins byte-equal across two consecutive rollups

## 5. Time-window additivity

> `rollup([t, t+1h)) ∪ rollup([t+1h, t+2h)) == rollup([t, t+2h))` for `games_started` and `games_completed`.

**Why it matters:** off-by-one bucketing bugs let the same event count toward two adjacent windows. Catches a class of regressions where a rollup change makes user-selected ranges non-additive.

**Enforced by:**
- `apps/server/src/integration/analyticsE2E.invariants.test.ts` — pins additivity for the two key counters

## 6. Alias closure

> For a visitor with `visitor_aliases.user_id = U`, every event row in `events`, `analytics_sessions`, and `visitor_profile` for that visitor has `user_id = U`.

**Why it matters:** anon-played-then-signed-up cohorts must surface in user-keyed dashboards. Without this, the entire pre-signup activity disappears from the loggedIn audience.

**Enforced by:**
- `apps/server/src/integration/analyticsE2E.identity.test.ts` — anon plays SP → linkVisitorToUser → assert pre-signup events stamped with user_id
- `apps/server/src/services/eventLog.test.ts` — unit-tests the `linkVisitorToUser` backfill itself

## 7. Schema-drift guard

> The column shape of `events`, `analytics_hourly`, `analytics_sessions`, `visitor_profile`, `visitor_aliases` is exactly what the snapshot says.

**Why it matters:** the rollup, V2 queries, and recordEvent UPSERT all read raw column names. A column rename that's missed at any callsite silently corrupts dashboards. The snapshot forces a doc/migration review at the PR diff.

**Enforced by:**
- `apps/server/src/services/analyticsSchema.test.ts` — `PRAGMA table_info` snapshot per table

## What's NOT enforced (yet)

The following properties from the unified-analytics plan are covered operationally by the sandbox driver (see below) but do not have in-process vitest tests yet:
- Late-arrival drop / inclusion bound (the rollup window has a 48h cap; events older than that are dropped)
- Funnel monotonicity end-to-end across many randomized flows (copies ≥ clicks ≥ joins ≥ completes — partially covered for share funnels in `analyticsV2.test.ts` but not under fast-check randomization)

## When a test here fails

1. **Don't update the snapshot blindly.** A schema-drift snapshot failure means a column changed; check `analyticsHourly.ts`, `analyticsV2.ts`, `eventLog.ts` for callsites that need updating before you accept the snapshot.
2. **Property-test counter-examples are gold.** `fast-check` prints the seed; re-run with the seed to reproduce the failing case deterministically.
3. **The `afterEach` hook fails the test that wrote the offending events.** Read the violation message; it names the specific invariant.

## Sandbox e2e + red-team driver

`scripts/sandbox-e2e.ts` is a pure-Node driver that hits a running sandbox over real HTTP and exercises the analytics surface against realistic + adversarial inputs. Run it from the repo root:

```bash
npx tsx scripts/sandbox-e2e.ts                             # default https://sandbox.price.games
SANDBOX_URL=http://localhost:3002 npx tsx scripts/sandbox-e2e.ts
npx tsx scripts/sandbox-e2e.ts --only=dedup,dos           # tag-filter
```

Scenarios cover the same invariants as the in-process E2E suite plus red-team probes that would be awkward to fold into vitest:
- happy-path GET / beacon ingest
- dedup retry tolerance
- malformed payloads (oversized, deeply nested, control-chars)
- DOS bound (200 envelopes back-to-back, no 5xx; rate limiter may 429)
- server-only event spoofing (game_completed via beacon)
- synthetic-flag leak attempt (`is_synthetic` in client-supplied properties)
- DNT bypass attempt (DNT=0 after sticky DNT=1)
- cookie-jar swap mid-session

Exit code is 0 on all-pass, 1 on any failure. Each scenario is independent so a single failure doesn't mask others.

## Why no Playwright pagehide test

We initially considered a single Playwright test verifying `pagehide` triggers the beacon's keepalive flush. We dropped it because:
- The pagehide handler logic is already covered in `apps/web/src/analytics/beacon.test.ts` via a synthetic event + mocked fetch.
- The only thing Playwright adds is "the browser actually fires pagehide on tab close" — a browser-API guarantee, not our code.
- Installing Playwright (~100MB browsers, CI config, new playwright.config.ts) for a single browser-API contract is poor cost-vs-coverage.

If a future regression specifically suspects pagehide-handler wiring, add Playwright in a focused infra PR rather than carrying the dep for one passing test.
