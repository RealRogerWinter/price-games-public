# Contributing to Price Games

Thanks for your interest in contributing! This document covers everything a human contributor needs to send a useful PR. (`CLAUDE.md` in the repo root is automation/AI-assistant guidance for tools like Claude Code; it is not required reading for human contributors, but the rules below apply to humans and automated assistants alike.)

## Quickstart

```bash
git clone https://github.com/<your-fork>/price-game.git
cd price-game
npm install
cp .env.example .env       # edit minimal required vars (see docs/QUICKSTART.md)
npm run seed               # seed sample products into SQLite
npm run dev                # server + web concurrently
```

Open the web app at `http://localhost:5173`, the server at `http://localhost:3001`.

The full first-run walkthrough — including which env vars you actually need locally, how to create an admin account, and how to run the optional Twitch streamer bot — is in **[`docs/QUICKSTART.md`](./docs/QUICKSTART.md)**.

## Project layout

This is an npm-workspaces monorepo:

- `apps/server/` — Express + Socket.IO backend, REST API, WebSocket server, static-file serving
- `apps/web/` — React 18 + Vite 7 frontend (single-page app)
- `apps/extension/` — Chrome extension for importing Amazon products
- `packages/shared/` — types, constants, scoring functions shared between server and web
- `packages/bot-streamer/` — autonomous Twitch bot ("Pricey") that plays the game live
- `docs/` — all project documentation. Start at [`docs/README.md`](./docs/README.md)

## Development workflow

### 1. Branch

Branch names follow `<type>/<short-description>`:

| Type | Use for |
|---|---|
| `feat/` | New user-visible features |
| `fix/` | Bug fixes |
| `refactor/` | Non-behavior-changing code changes |
| `test/` | Test-only additions |
| `docs/` | Documentation-only changes |
| `chore/` | Tooling, deps, CI |

Example: `feat/comparison-mode-multiplayer`, `fix/lobby-countdown-race`.

### 2. Test-driven where it makes sense

For new logic, write a failing test first, then make it pass. Tests and implementation should land in the **same commit**.

```bash
# Server tests (vitest)
npm run test:server
npx vitest run apps/server/src/path/to/file.test.ts

# Web tests (vitest + jsdom)
npm run test:web
npx vitest run apps/web/src/path/to/file.test.tsx --config apps/web/vite.config.ts

# Typecheck (fast — run before pushing)
npx tsc --noEmit -p apps/server/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```

The full test suite runs in CI on every push, so locally you can focus on the file you're touching.

### 3. Commit style

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): imperative summary`.

```
feat(daily): add streak grace period for missed days
fix(streamer): bind myPlayerId so bidding war places bids
docs(scoring): document scoreBiddingSolo for daily challenges
```

One logical change per commit. Tests and docs for a change belong in the same commit as the change.

### 4. Style rules

- **Exported functions, classes, and methods** require a doc comment describing what it does, params, return, and errors.
- **Complex logic** gets a brief inline comment explaining *why* (not what).
- **TODOs** must include author + date: `// TODO(handle, YYYY-MM-DD): description`.
- No `// removed` graveyard comments; let `git log` carry the history.
- Default to no comments on obvious code — well-named identifiers are the documentation.

There is no automated linter yet, but typecheck must pass.

### 5. Documentation updates

Every PR that changes user-visible or contributor-visible behavior must update the relevant doc:

| Change | Doc to touch |
|---|---|
| New game mode | `docs/GAME_MODES.md`, `docs/SCORING.md`, `docs/API_REFERENCE.md`, `docs/WEBSOCKET_EVENTS.md`, `docs/ARCHITECTURE.md` |
| New REST endpoint | `docs/API_REFERENCE.md` |
| New socket event | `docs/WEBSOCKET_EVENTS.md` |
| New table or migration | `docs/DATABASE.md` |
| Deployment / infra change | `docs/DEPLOYMENT.md` |
| Streamer-bot change | `docs/STREAMER.md` (ops) or `docs/streamer/*.md` (architecture) |

When you touch a doc, **bump its `last_reviewed` date** in the frontmatter so
the staleness tracker stays honest. Each doc under `docs/` carries frontmatter
(`status`, `last_reviewed`, `owner`, `related_code`, …); the index at
[`docs/README.md`](./docs/README.md) is generated from it. After editing docs,
run:

```bash
npm run docs:index   # regenerate the index from frontmatter
npm run docs:check   # validate frontmatter, index sync, and links (CI runs this too)
```

See [`docs/DOCUMENTATION.md`](./docs/DOCUMENTATION.md) for the full convention.

### 6. Open a PR

1. Push your branch.
2. Open a PR — title is a Conventional Commit summary; body describes what changed and why.
3. CI runs build + tests + coverage automatically on CircleCI.
4. Coverage thresholds are enforced: **server ≥ 85% line and branch**, **web ≥ 75% line and branch**. If your change drops coverage below those, add tests before merging.
5. A maintainer reviews. Once approved and green, squash-merge.

## Adding a new game mode

We have a dedicated walkthrough in [`docs/GAME_MODES.md`](./docs/GAME_MODES.md) — see the "How to add a new game mode" section. The short version: register in `VALID_GAME_MODES`, write a scoring function in `packages/shared/src/scoring.ts`, wire up the round composer in `apps/server/src/services/`, add a page component + route in `apps/web/src/`, and write tests for both halves.

## Working on the streamer bot

The bot is the most complex moving part. Start at [`docs/streamer/architecture.md`](./docs/streamer/architecture.md) for the loop diagram, then jump to whichever subsystem you're touching (strategies, chat, mood, TTS, observer, learning). [`docs/streamer/dev.md`](./docs/streamer/dev.md) covers running and debugging the bot locally without needing a live Twitch stream.

## Code of Conduct

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md). Be kind. Assume good faith. Help newcomers.

## Security

Found a vulnerability? Please report it privately per [`SECURITY.md`](./SECURITY.md) rather than opening a public issue.

## Questions?

- Bugs and concrete proposals → GitHub Issues
- Open-ended questions → see [`SUPPORT.md`](./SUPPORT.md)
- Quick docs orientation → [`docs/README.md`](./docs/README.md)

Welcome aboard.
