# Project Context — Price Games

## Stack
- Language: TypeScript 5.4+
- Framework: Express + Socket.IO (backend), React 18 + Vite 7 (frontend)
- Monorepo: npm workspaces (`packages/*`, `apps/*`)
- Package manager: npm
- Node version: 20.19+
- Database: SQLite (better-sqlite3)
- Production: Docker + Caddy reverse proxy

## Directory Structure
- `apps/server/` — Express + Socket.IO backend (REST API, WebSocket, static serving)
- `apps/web/` — React + Vite frontend (game UI, multiplayer)
- `apps/extension/` — Chrome extension for importing Amazon products
- `packages/shared/` — Shared types, constants, scoring functions
- `docs/` — project documentation
- `.claude/` — agents, commands, and config

## Commands
- Build: `npm run build` (builds shared → server → web in order)
- Dev: `npm run dev` (runs server + web concurrently)
- Seed DB: `npm run seed`
- Build server only: `npm run build -w apps/server`
- Build web only: `npm run build -w apps/web`
- Typecheck server: `npx tsc --noEmit -p apps/server/tsconfig.json`
- Typecheck web: `npx tsc --noEmit -p apps/web/tsconfig.json`
- Security audit: `npm audit`
- Test (all): `npm test` (runs server + web tests)
- Test (server only): `npm run test:server`
- Test (web only): `npm run test:web`
- Test with coverage: `npm run test:coverage`
- Test watch (server): `npm run test:watch -w apps/server`
- Test watch (web): `npm run test:watch -w apps/web`
- Sandbox: `npm run sandbox` / `sandbox:down` / `sandbox:rebuild` / `sandbox:seed`
- Sandbox (worktree): `SANDBOX_PORT=<port> npm run sandbox`
- **NOT YET CONFIGURED:** lint

## CI/CD Pipeline
- CircleCI runs on every push: build → test-server + test-web (parallel) → docker-push → deploy (main only)
- Tests and coverage are validated by the pipeline — do not run `npm test` or `npm run test:coverage` locally
- Use CircleCI MCP server (`get_latest_pipeline_status`) to check pipeline results
- Use `get_build_failure_logs` to diagnose failures
- Always run typechecks locally before pushing (fast, catches most issues)
- Local test execution is only for TDD and debugging CI failures

## Development Workflow

### Phase 1: Plan
Use plan mode for non-trivial tasks. Explore codebase, design approach, get user approval.

### Phase 2: Implement (Test-Driven)
Write failing tests first → implement to pass → typecheck → commit tests + code together.

### Phase 3: Sandbox Testing
`npm run sandbox` builds locally and starts on port 3002 (`https://sandbox.price.games`). Each worktree gets its own isolated container and database via `SANDBOX_PORT=<port> npm run sandbox`.

### Phase 4: Open PR
Typecheck → push → draft PR → **parallel** review pass → implement findings → CI green → mark ready.

**The review pass MUST be:**
1. Immediately after opening the draft PR, spawn TWO sub-agents in parallel (single message, two Agent tool calls):
   - **Senior code reviewer** — general code-quality pass: correctness, design flaws, readability, missing tests, optimization opportunities, adherence to project conventions in CLAUDE.md.
   - **Senior security engineer** — threats, injection/auth/crypto/data-exposure vulns, hardening recommendations, overall security posture.
2. Each sub-agent MUST post its findings as a comment on the PR via `gh pr comment <PR#> --body "..."`. Do not just return findings to the main conversation — the comment on the PR is the durable artifact.
3. After both agents return, read their PR comments, then implement their suggestions in code. Push fixes to the same branch.
4. Poll CI until green; fix any failures.
5. Post a final summary comment describing what was changed in response to review and what was deferred (with rationale).
6. Mark the PR ready for review (`gh pr ready <PR#>`).

This applies to every PR going forward. The two reviewer agents always run in parallel — never sequentially.

## Branch Naming
`<type>/<short-description>` where type is: refactor, feat, fix, test, docs, chore

## Commit Style
Conventional Commits: `type(scope): imperative summary`
One logical change per commit. Tests and docs for a change go in the same commit.

## Hard Rules
- IMPORTANT: **Server** coverage must stay ≥ 85% line and branch. **Web** coverage must stay ≥ 75% line and branch. If a change drops coverage below these thresholds, add tests before merging.
- IMPORTANT: Every PR must pass security review via the `security-reviewer` agent before merge.
- Never commit secrets, credentials, or API keys.

## Security Review Scope
- Security reviews must only flag files included in the PR diff or git-tracked files.
- Do NOT flag `.env` or other gitignored files that exist only on disk — these are out of scope for PR reviews.
- Operational concerns about on-disk credentials (rotation, password strength) should be noted as informational, not as PR blockers.

## Style
- Exported functions, classes, and methods require doc comments (what, params, return, errors)
- Complex logic gets a brief inline comment explaining *why*
- TODOs must include date and author: `// TODO(author, YYYY-MM-DD): description`

## Documentation
- `README.md` is a concise overview + quickstart (~120 lines). Links to detailed docs.
- `docs/` contains one file per topic, each with YAML frontmatter (`status`, `last_reviewed`, `owner`, `related_code`). `docs/README.md` is the generated index — see `docs/DOCUMENTATION.md` for the system.
- Every doc must be listed in `docs/README.md` and carry valid frontmatter; `npm run docs:check` (also run in CI) enforces this, flags broken relative links, and warns when `related_code` changed after `last_reviewed`.
- Every PR that adds/changes a feature MUST update the relevant doc files and bump their `last_reviewed`.
- Checklist: new game mode -> GAME_MODES.md, SCORING.md, API_REFERENCE.md, WEBSOCKET_EVENTS.md, ARCHITECTURE.md. New endpoint -> API_REFERENCE.md. New socket event -> WEBSOCKET_EVENTS.md. New table/migration -> DATABASE.md. Deployment change -> DEPLOYMENT.md.

## Image Assets (generated via the `image-generation` skill)

Generated images have **no remote backup** — Google Gemini does not archive them and Anthropic does not store them. The copy written to disk is the only copy. Never save to `/tmp` (volatile) or the repo (would bloat git history unboundedly as we keep generating). We maintain a durable host-level archive outside the repo instead.

### Canonical save location: the image archive

All generated images live under `$IMAGE_ARCHIVE_ROOT/images/<namespace>/<slug>.<ext>` (default `~/image-archive/images/`, override via env var). Each image has a companion JSON sidecar at `<slug>.json`. The admin gallery (`/admin/gallery`) reads this directory at runtime via the server API — no rebuild required to surface new files.

- **NEVER save generated images to `/tmp`, `apps/web/src/assets/`, or the repo root.** `apps/web/src/assets/` is reserved for "promoted" production assets that are actually referenced by code; it is NOT the archive.
- **ALWAYS** save to `$IMAGE_ARCHIVE_ROOT/images/<namespace>/<slug>.<ext>` where:
  - `<namespace>` is a short descriptive bucket for the batch (e.g. `avatars-sticker-pop`, `mode-icons-neon-retro`, `backgrounds-seamless-v2`, `mockup-explorations`). Collisions inside a namespace are not allowed.
  - `<slug>` is lowercase, kebab-case, and descriptive (`pirate.png`, not `image1.png` or `IMG_2024.png`).
- Filename extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` are supported.

### Sidecar metadata (REQUIRED)

Every image MUST be accompanied by a JSON sidecar written to the **same path with a `.json` extension**. Write it immediately after generation — the write can happen concurrently with the image write, and MUST complete before moving on from the generation task. Without a sidecar, the gallery still shows the file but with defaulted metadata, and provenance (what prompt generated this?) is lost forever.

Sidecar schema (all fields optional except where noted; the gallery will backfill defaults):

```json
{
  "title": "Pirate Avatar",
  "category": "avatars",
  "tags": ["avatar", "character", "pirate", "sticker-style"],
  "description": "Friendly pirate avatar for multiplayer rooms",
  "prompt": "<the exact prompt passed to the generator>",
  "model": "gemini-3-pro-image-preview",
  "aspectRatio": "1:1",
  "createdAt": "2026-04-11T14:30:00Z",
  "source": "generated"
}
```

- **`category`** — drives the gallery's tab grouping. Reuse existing categories when one fits (use `/admin/gallery` to check) or introduce a new one freely; new categories surface as new tabs automatically.
- **`tags`** — free-form array, used by the gallery's search filter.
- **`prompt`** — save the full prompt you passed to the image CLI. This is the provenance record; without it we cannot reproduce the image.
- **`source`** — one of `generated` (created fresh), `migrated` (moved from somewhere else), `imported` (brought in from outside).
- **`createdAt`** — ISO timestamp; the gallery falls back to the file's birth time if omitted.

### Generation workflow

When you generate an image via the image-generation skill:

1. Pick the namespace and slug up front.
2. Run the generator with `--output $IMAGE_ARCHIVE_ROOT/images/<namespace>/<slug>.<ext>` (create the namespace directory first if needed).
3. Immediately write the sidecar to the same path with `.json` extension. The metadata write can run concurrently with generation if useful — the two are independent files.
4. Open `/admin/gallery` and click Refresh to confirm the new image + metadata appear correctly.
5. If an image is a draft/experiment, still archive it — tag it `draft` or `exploration` rather than discarding. The whole point of the archive is to never lose a generation again.

### Gallery / CRUD

- Admin UI at `/admin/gallery` lists every asset in the archive, grouped into tabs by category. It uses the API at `/api/admin/gallery/*` which re-scans the filesystem on every request, so freshly-saved images show up as soon as you click Refresh.
- From the gallery you can edit title / category / tags / description / prompt, or delete an asset entirely. Edits are persisted back to the sidecar JSON.
- Use the gallery to check whether a similar asset already exists **before** spending generation calls on a new one.

### Backup / re-importing stray images

`scripts/backup-images-to-archive.mjs` walks a set of known-volatile source directories (`/tmp/*`, `~/layouts`, etc.) and copies every image into the archive with an inferred sidecar. Idempotent — safe to rerun. Run it after generating images in a scratch location to pull them back into the archive:

```bash
node scripts/backup-images-to-archive.mjs --dry-run   # preview
node scripts/backup-images-to-archive.mjs             # execute
node scripts/backup-images-to-archive.mjs --source /some/other/dir
```
