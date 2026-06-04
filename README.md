# Price Games

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CircleCI](https://img.shields.io/circleci/build/github/price-games/price-game/main?label=ci)](https://app.circleci.com/pipelines/github/price-games/price-game)
[![Node: 20.19+](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)](https://nodejs.org)
[![Live: price.games](https://img.shields.io/badge/live-price.games-blue)](https://price.games)

A multiplayer web game where players guess Amazon product prices. Twelve game modes, real-time multiplayer over WebSocket, persistent user accounts with OAuth, a daily challenge, lifetime leaderboards — and an autonomous AI bot mascot ("Pricey") who plays the game live on Twitch.

Live at **[price.games](https://price.games)**.

> **Why it exists.** Guessing what everyday things cost is fun because you get to play along from the couch. We wanted that feeling on the web, against real people, on real products, with a scoring system that rewards good guesses without punishing newcomers too hard. Twelve modes give the same products different shapes — sometimes you're naming a price, sometimes you're ranking three products, sometimes you're filling a shopping basket against a budget. The streamer bot is what happens when you let the AI you wrote to play your game *actually play your game*, on Twitch, 24/7.

## Architecture

```
                         ┌──────────────┐
                         │    Caddy      │
            Internet ───▶│  (HTTPS/TLS) │
                         │ price.games   │
                         └──────┬───────┘
                                │ reverse_proxy :3001
                                ▼
                   ┌────────────────────────┐
                   │   Express + Socket.IO  │
                   │       (port 3001)      │
                   │                        │
                   │  /api/*    REST API    │
                   │  /socket.io  WebSocket │
                   │  /*   Static frontend  │
                   └───────────┬────────────┘
                               │
                               ▼
                        ┌─────────────┐
                        │   SQLite    │
                        │ (products,  │
                        │  sessions,  │
                        │  scores,    │
                        │  users)     │
                        └─────────────┘
```

In production, the Express server serves everything — the built React frontend as static files, the REST API, and WebSocket connections. Caddy handles TLS termination. The app runs in a Docker container; the streamer bot runs in a sibling container that joins the same overlay network.

## Project structure

```
price-game/                       # npm workspaces monorepo
├── apps/
│   ├── server/                   # Express + Socket.IO backend
│   ├── web/                      # React + Vite frontend
│   └── extension/                # Chrome extension for Amazon product importing
├── packages/
│   ├── shared/                   # Shared types, constants, scoring functions
│   └── bot-streamer/             # Pricey — the autonomous Twitch streaming bot
├── docs/                         # Documentation — start at docs/README.md
└── package.json                  # Workspace root
```

## Quickstart

```bash
git clone https://github.com/price-games/price-game.git
cd price-game
cp .env.example .env              # edit minimal required vars
npm install
npm run seed                      # seed sample products into SQLite
npm run dev                       # server + web concurrently
npm test                          # run all tests
npm run build                     # production build
```

Dev runs Vite (`http://localhost:5173`) and Express (`http://localhost:3001`) concurrently. Vite proxies `/api` and `/socket.io` to the backend.

For a fresh-fork walkthrough including which `.env` vars you actually need, how to create a local admin, and how to run the streamer bot, see **[`docs/QUICKSTART.md`](./docs/QUICKSTART.md)**.

## Tech stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Vite 7, TypeScript 5.4+, React Router 7 |
| Backend | Express, Socket.IO, TypeScript |
| Database | SQLite (better-sqlite3) |
| Auth | bcryptjs, httpOnly session cookies, OAuth 2.0 (Google, Facebook, Amazon), Cloudflare Turnstile, TOTP for admins |
| Email | Resend (transactional: verification, password reset, notifications) |
| Push | Web Push (VAPID) |
| Streamer bot | Playwright (Chromium), Piper TTS, mpd, ffmpeg, nginx-rtmp; worker-thread MLP for online learning |
| Testing | Vitest, @vitest/coverage-v8, React Testing Library |
| Infrastructure | Docker + docker-compose, Caddy (automatic HTTPS), Tailscale (admin access) |
| CI/CD | CircleCI (build → tests → docker push → deploy) |
| Monorepo | npm workspaces |

## Documentation

The full doc index lives at **[`docs/README.md`](./docs/README.md)** — start there. A short orientation:

- New to the project? Read [`docs/QUICKSTART.md`](./docs/QUICKSTART.md), then [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
- Looking for the gameplay rules? [`docs/GAME_MODES.md`](./docs/GAME_MODES.md) and [`docs/SCORING.md`](./docs/SCORING.md).
- Integrating with the API? [`docs/API_REFERENCE.md`](./docs/API_REFERENCE.md) and [`docs/WEBSOCKET_EVENTS.md`](./docs/WEBSOCKET_EVENTS.md).
- Curious about the bot? [`docs/STREAMER.md`](./docs/STREAMER.md) (ops) and [`docs/streamer/`](./docs/streamer/) (architecture, strategies, mood, TTS, online learning).
- Deploying? [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the workflow (branch naming, commit style, test expectations, doc checklist) and [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) for community standards.

If you're filing a security issue, please follow [`SECURITY.md`](./SECURITY.md) and report privately.

## Acknowledgments

Price Games leans on excellent open-source infrastructure:

- **[Piper TTS](https://github.com/rhasspy/piper)** — the voice behind Pricey
- **[mpd](https://www.musicpd.org/)** — music playback for the live stream
- **[ffmpeg](https://ffmpeg.org/)** and **[nginx-rtmp](https://github.com/arut/nginx-rtmp-module)** — stream composition and ingress
- **[Caddy](https://caddyserver.com/)** — automatic HTTPS and reverse proxy
- **[Socket.IO](https://socket.io/)**, **[React](https://react.dev/)**, **[Vite](https://vitejs.dev/)**, **[Express](https://expressjs.com/)**, **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** — the everyday tools
- **[Playwright](https://playwright.dev/)** — the bot's eyes and hands

## License

[MIT](./LICENSE) © Price Games contributors.
