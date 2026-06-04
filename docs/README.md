# Documentation

Everything you need to understand, run, contribute to, or operate Price Games.

**New here?** Start with [Quickstart](./QUICKSTART.md) (fork → run locally), then
[Architecture](./ARCHITECTURE.md) for the big picture. Otherwise jump to the
section you need below.

Repo-root files worth knowing: [`../README.md`](../README.md),
[`../CONTRIBUTING.md`](../CONTRIBUTING.md), [`../SECURITY.md`](../SECURITY.md),
[`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md), [`../SUPPORT.md`](../SUPPORT.md),
[`../CHANGELOG.md`](../CHANGELOG.md).

The table below is **generated** from each doc's frontmatter by
`scripts/check-docs.mjs` — edit a doc's frontmatter (not this table) and run
`npm run docs:index` to refresh. See [DOCUMENTATION.md](./DOCUMENTATION.md) for
the conventions (status values, review dates, staleness checks).

<!-- BEGIN AUTOGEN-INDEX -->

### Getting started

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Quickstart](./QUICKSTART.md) | stable | 2026-06-03 | Fork → clone → install → run, with the minimum env config. |

### Architecture

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Architecture](./ARCHITECTURE.md) | stable | 2026-06-03 | The big picture: how the server, client, shared package, extension, and streamer bot fit together. |

### Game design

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Auto Lobbies](./AUTO_LOBBIES.md) | stable | 2026-06-03 | Quickplay matchmaking: auto-spawned lobbies, bot disguise, fill-up logic. |
| [Daily Mode](./DAILY_MODE.md) | stable | 2026-06-03 | The once-a-day puzzle: rotation, seeding, streaks, sharing. |
| [Game Modes](./GAME_MODES.md) | stable | 2026-06-03 | All game modes — rules, products per round, timers, multiplayer support, plus a how-to-add-a-mode walkthrough. |
| [Ghost Users](./GHOST_USERS.md) | stable | 2026-06-03 | Anonymous play, ghost-to-real account conversion, and history retention. |
| [Multiplayer Invites](./MULTIPLAYER_INVITES.md) | stable | 2026-06-03 | Inviting friends to a lobby: links, QR codes, and the reward economy. |
| [Product Universe](./PRODUCT_UNIVERSE.md) | beta | 2026-06-03 | AI-enriched product taxonomy, the galaxy visualization, and manufacturer tracking. |
| [Scoring](./SCORING.md) | stable | 2026-06-03 | The scoring formulas, tiers, and bonuses for each mode. |

### API & protocol

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [API Reference](./API_REFERENCE.md) | stable | 2026-06-03 | All REST endpoints — public, authenticated, and admin. |
| [WebSocket Events](./WEBSOCKET_EVENTS.md) | stable | 2026-06-03 | All Socket.IO events with payload schemas and ack error codes. |

### Operations

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Admin Guide](./ADMIN_GUIDE.md) | stable | 2026-06-03 | Using the /admin dashboard: products, rewards, banners, content pages, ghost users, 2FA. |
| [Database](./DATABASE.md) | stable | 2026-06-03 | Every table, every migration, backup and restore. |
| [Deployment](./DEPLOYMENT.md) | stable | 2026-06-03 | Running in production: Docker, Caddy, CI/CD, env vars. |

### User-facing features

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Email Notifications](./EMAIL_NOTIFICATIONS.md) | stable | 2026-06-03 | Resend integration, transactional templates, unsubscribe. |
| [Web Push Notifications](./NOTIFICATIONS.md) | stable | 2026-06-03 | Web-push: VAPID, urgency, badge format, Chrome quirks. |
| [SEO](./SEO.md) | stable | 2026-06-03 | Sitemap, robots.txt, per-route meta injection, admin-editable content pages. |
| [Results Sharing](./SHARING.md) | stable | 2026-06-03 | Wordle-style results sharing — text, PNG, and shareable URLs. |
| [User Accounts](./USER_ACCOUNTS.md) | stable | 2026-06-03 | Registration, OAuth (Google, Facebook, Amazon), sessions, password reset. |

### Streamer bot (Pricey)

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Streamer Bot — Operations](./STREAMER.md) | stable | 2026-06-03 | Ops runbook: deployment, day-to-day operations, persona swaps, music updates, monitoring. |
| [Streamer — Architecture](./streamer/architecture.md) | stable | 2026-06-03 | The runner loop: lifecycle → driver → observer → strategy → enact → outcome → narrator → mood. |
| [Streamer — Chat](./streamer/chat.md) | stable | 2026-06-03 | Twitch chat ingestion, command routing, rate limits, and adding a new chat command. |
| [Streamer — Deploy](./streamer/deploy.md) | stable | 2026-06-03 | Dockerfile variants, env vars, healthchecks, off-host migration. |
| [Streamer — Local Dev](./streamer/dev.md) | stable | 2026-06-03 | Running the bot locally without streaming. Test patterns, fixtures, debugging. |
| [Streamer — Heuristics](./streamer/heuristics.md) | stable | 2026-06-03 | Domain knowledge (brand tiers, category ranges) used as fallback or grounding. |
| [Streamer — Learning](./streamer/learning.md) | beta | 2026-06-03 | The online-learning MLP: architecture, replay buffer, worker isolation, operational guards. |
| [Streamer — Mood](./streamer/mood.md) | stable | 2026-06-03 | Vibe/morale state machine, prosody, and mood-driven sprite selection. |
| [Streamer — Observer](./streamer/observer.md) | stable | 2026-06-03 | What the bot sees: state snapshots and auto-binding myPlayerId. |
| [Streamer — Strategies](./streamer/strategies.md) | stable | 2026-06-03 | How the bot decides what to do per game mode, and how to add a new strategy. |
| [Streamer — TTS & Thinker](./streamer/tts-thinker.md) | stable | 2026-06-03 | Piper TTS pipeline, mouth animation, and the visual-only Thinker thought bubbles. |

### Browser extension

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Browser Extension](./EXTENSION.md) | stable | 2026-06-03 | Chrome extension for importing Amazon products: build, install, usage. |

### Analytics

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Analytics Invariants](./analytics-invariants.md) | stable | 2026-06-03 | Invariants the analytics pipeline must uphold; how to add a new event safely. |
| [Analytics](./ANALYTICS.md) | stable | 2026-06-03 | What we track, how, and why. Beacon limiter and event schema. |

### Testing

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Testing](./TESTING.md) | stable | 2026-06-03 | Vitest setup, coverage thresholds, test patterns, CI integration. |

### Documentation system

| Doc | Status | Reviewed | What it covers |
|---|---|---|---|
| [Documentation System](./DOCUMENTATION.md) | stable | 2026-06-03 | How the docs are tracked — frontmatter schema, the generated index, and the docs:check linter. |

<!-- END AUTOGEN-INDEX -->
