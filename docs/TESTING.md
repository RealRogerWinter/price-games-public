---
title: Testing
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: testing
summary: Vitest setup, coverage thresholds, test patterns, CI integration.
related_code:
  - apps/server/vitest.config.ts
  - apps/web/vite.config.ts
---
# Testing

## Commands

```bash
npm test                                # Run all tests (server + web)
npm run test:server                     # Server tests only
npm run test:web                        # Web tests only
npm run test:coverage                   # Run with coverage report
npm run test:watch -w apps/server       # Watch mode (server)
npm run test:watch -w apps/web          # Watch mode (web)
```

## Coverage Thresholds

- **Server**: Minimum **85%** for statements, branches, functions, and lines
- **Web**: Minimum **75%** for lines and branches

Configured in `apps/server/vitest.config.ts` and `apps/web/vitest.config.ts`. PRs that drop coverage below these thresholds must add tests before merging.

## Frameworks

| Component | Framework | Environment |
|-----------|-----------|-------------|
| Server | Vitest + @vitest/coverage-v8 | Node.js |
| Web | Vitest + jsdom + React Testing Library + @testing-library/user-event | jsdom |
| Extension | Vitest | Node.js |

## Test Suite

| Component | Files | Description |
|-----------|-------|-------------|
| Server | ~152 | Unit tests, service tests, integration tests |
| Web | ~184 | Component tests, hook tests, API client tests, admin panel tests |
| Extension | ~2 | Scraper, product detection, API client |
| **Total** | **~338** | |

## Test Isolation

### Server
- Each test file uses an **in-memory SQLite database** via `createTestDb()` from `apps/server/src/test/dbHelper.ts`
- DB mocking pattern: `vi.mock("../db")` with dynamic `await import()` for module-level DB replacement
- Test helpers: `seedUser()`, `seedAdminUser()`, `seedProducts()`, `seedAnalyticsData()`

### Web
- `testUtils.tsx` provides `renderWithProviders` (wraps with CurrencyContext), `makeProduct`, `makePlayer`, `makeUser` factories
- API mocking: `vi.spyOn(globalThis, "fetch")` for REST calls, `vi.mock("../api/client")` for module mocks

## Integration Tests

Located in `apps/server/src/integration/`:

| Test File | Coverage |
|-----------|----------|
| `multiplayerFlow.test.ts` | Full multiplayer lifecycle via Socket.IO |
| `disconnectReconnect.test.ts` | Disconnect, reconnect, host promotion |
| `timerAndRaces.test.ts` | Timer expiry, race conditions, double-end prevention |
| `crossModeRegression.test.ts` | All 11 game modes through Socket.IO pipeline |
| `singlePlayerFlow.test.ts` | Full 10-round single-player for all modes + hints |
| `leaderboardIntegration.test.ts` | SP/MP leaderboard save, placement, filtering |
| `passwordAndEdgeCases.test.ts` | Passwords, round counts, continue voting, kick |
| `adminAuthFlow.test.ts` | Admin login -> analytics -> logout end-to-end |
| `userAuthFlow.test.ts` | Register -> login -> me -> change password -> logout end-to-end |
| `extensionImportFlow.test.ts` | Chrome extension product import end-to-end |
| `analyticsE2E.sp.test.ts` | Analytics rollups for the single-player flow |
| `analyticsE2E.mp.test.ts` | Analytics rollups for the multiplayer flow |
| `analyticsE2E.identity.test.ts` | Analytics identity-resolution edge cases |
| `analyticsE2E.dedup.test.ts` | Deduplication of the analytics ingest path |
| `analyticsE2E.invariants.test.ts` | Property-based analytics invariants (fast-check) |
| `beaconIngest.test.ts` | Analytics beacon ingest path end-to-end |

Integration tests use a real HTTP + Socket.IO server via `socketHelper.ts` with real `socket.io-client` connections.
