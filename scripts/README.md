# Scripts

Operational and developer scripts. Most are invoked from the repo root via `node scripts/<name>` or `bash scripts/<name>`.

Tag legend:
- **[dev]** — useful during local development
- **[ci]** — invoked by CircleCI
- **[ops]** — operator-only, runs against the production host
- **[gen]** — content generation (images, seeds, datasets)

## Sandbox + dev

| Script | Tag | Purpose |
|---|---|---|
| `sandbox.sh` | dev | Bring up / down / rebuild / seed the local Docker sandbox. Wrapped by `npm run sandbox*` commands. |
| `sandbox-seed.js` | dev | Sample-product seed for the sandbox DB. |
| `sandbox-e2e.ts` | dev | Headless Puppeteer smoke run against the sandbox. |
| `sandbox-config.mjs` | dev | Reads sandbox host/port from env + `.env.sandbox`. |
| `sandbox-config.test.ts` | ci | Unit tests for `sandbox-config.mjs`. |
| `lh-game.mjs` | dev | Lighthouse run against a local game URL. |

## Image archive

| Script | Tag | Purpose |
|---|---|---|
| `backup-images-to-archive.mjs` | dev | Walk known volatile dirs and pull stray images into `$IMAGE_ARCHIVE_ROOT/images/`. Idempotent. |
| `convert-home-icons-to-webp.mjs` | gen | One-shot conversion of home-page mode icons to WebP. |
| `gemini-edit.mjs` | gen | Image generation CLI (used by the `image-generation` skill). Reads `GEMINI_API_KEY` from `~/.bashrc`. |

## Streamer bot — content + ops

| Script | Tag | Purpose |
|---|---|---|
| `regen-pricey-mouth-sprites.mjs` | gen | Regenerate the per-mood / per-aperture mouth sprites for the bot's avatar. Calls Gemini under the hood. |
| `clean-pricey-mood-sprites.py` | gen | Background-removal cleanup pass for generated sprites. |
| `diag-lipsync.mjs` | dev | Diagnose lip-sync timing — captures TTS chunks and overlay events for analysis. |
| `verify-real-tts-cycle.mjs` | dev | End-to-end verification that the TTS pipeline emits a usable cycle (PCM → overlay → mouth). |
| `streamer-redeploy.sh` | ops | Rebuild + restart the streamer container on the host. |
| `streamer-parachute-snapshot.sh` | ops | Take an emergency snapshot of streamer state (learning DB + snapshots + logs) for offline debugging. |
| `nn-rollback.sh` | ops | Roll the bot's online-learning NN back to a specific snapshot round. |

## Online-learning seeds

| Script | Tag | Purpose |
|---|---|---|
| `build-brand-tier-seed.mjs` | gen | Build `brand-tiers.json` from production gameplay history. Optional input for the bot's feature extractor. |
| `build-golden-eval-seed.mjs` | gen | Build `golden-eval.json` — per-mode MAE baseline for OOD-drift detection on the bot's NN. |

## Product Universe enrichment

| Script | Tag | Purpose |
|---|---|---|
| `run-enrichment.js` | ops | Trigger AI enrichment over products that lack PU data. Operator-only — calls paid Claude APIs. |
| `seed-universe.js` | dev | Seed Product Universe tables with a starter set so the galaxy view renders before enrichment has run. |

## Infrastructure

| Script | Tag | Purpose |
|---|---|---|
| `ensure-admin-tailscale-serve.sh` | ops | Idempotent self-healing wrapper around `tailscale serve` so an admin-panel outage can't lock the operator out. See [`DEPLOYMENT.md`](../docs/DEPLOYMENT.md). |

## Test / config

| Script | Tag | Purpose |
|---|---|---|
| `vitest.config.ts` | ci | Vitest config for the small set of script-level tests (e.g. `sandbox-config.test.ts`). |
