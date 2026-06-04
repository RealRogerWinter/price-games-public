# Product Universe — PARKED

Parked on 2026-04-16. Source retained for future resumption.

## Scope of the park
- `apps/server/src/routes/universe.ts`
- `apps/server/src/services/universe/**`
- `apps/server/src/services/ai/**` (only used by universe)
- `apps/web/src/pages/universe/**`
- `apps/web/src/components/universe/**`
- `apps/web/src/api/universeClient.ts`

## What is disabled
- Frontend `/universe/*` route — unmounted in `apps/web/src/App.tsx`
- Backend `/api/pu` mount + job processor — unmounted in `apps/server/src/index.ts`
- TS compilation — excluded in `apps/server/tsconfig.json` + `apps/web/tsconfig.json`
- Test suite — all universe + ai tests deleted
- Coverage — excluded in `apps/server/vitest.config.ts`

## What is kept
- DB schema (`CREATE TABLE IF NOT EXISTS` in `apps/server/src/db.ts`) — tables exist but stay empty
- Config env vars (`puAnthropicApiKey`, `puRateLimit`, etc. in `apps/server/src/config.ts`)
- `.env.example` entries for universe

## How to resume
1. Remove the universe / ai exclusion lines from `apps/server/tsconfig.json` and `apps/web/tsconfig.json`
2. Remove the coverage exclusions from `apps/server/vitest.config.ts`
3. Restore the route mounts (see commit history at `46a20fe` for the pre-park `App.tsx` and `index.ts`)
4. Write fresh tests — the old ones were deleted; do not try to restore them from git
