# Changelog

All notable changes to Price Games will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project (loosely) adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Historic development happened in a private repository; this changelog starts at the first public release.

## [Unreleased]

### Added
- Open-source release scaffolding: `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `.github/` issue and PR templates, `dependabot.yml`
- `docs/README.md` documentation index organizing 30+ topic docs
- `docs/QUICKSTART.md` for fresh-fork contributors
- `docs/streamer/` deep-dive subdirectory for the autonomous Twitch bot (architecture, strategies, chat, mood, TTS/Thinker, observer, heuristics, online learning, local dev, deployment)
- `scripts/README.md` listing every script with purpose and audience

### Changed
- README.md: added badges, vision statement, contribution and license sections; doc-link table now points to the central `docs/README.md` index
- `docs/API_REFERENCE.md`: added Admin API section, streamer relay endpoints, error code enumeration, and previously undocumented public routes
- `docs/WEBSOCKET_EVENTS.md`: enumerated ack error codes, inlined payload types, added per-mode `guessData` table
- `docs/DATABASE.md`: added `shared_games` and `manufacturer_contacts` tables; expanded `site_settings` keys; corrected migration count
- `docs/SCORING.md`: documented `scoreBiddingSolo` and `scoreChainSubGuess`, completed bidding placement tiers, replaced stub formulas with the real ones from `packages/shared/src/scoring.ts`
- `docs/GAME_MODES.md`: added bidding-solo variant, "how to add a new game mode" walkthrough, per-mode `guessData` shape table, timer table, and how-to-play UX paragraphs per mode
- `docs/ARCHITECTURE.md`: updated mode count and migration count, added missing route modules, added Frontend State Management subsection, added Configuration env-var summary, added Migration Workflow subsection
- `docs/DEPLOYMENT.md`: marked pm2 section as legacy, documented streamer env vars and sandbox-skip flags, added env-var generation commands and "deploy your own fork" runbook
- `docs/ADMIN_GUIDE.md`: clarified initial-admin seeding semantics

### Removed
- Root-level `ARCHITECTURE.md` stub (canonical doc lives at `docs/ARCHITECTURE.md`)

---

## How to update this file

When you open a PR:

1. Add an entry under `## [Unreleased]` in the appropriate subsection (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`).
2. Keep entries user-facing. "Refactored internal helper" is not a changelog entry; "added pagination to leaderboard" is.
3. When cutting a release, rename `[Unreleased]` to the new version, add a date, and start a fresh `[Unreleased]` block at the top.
