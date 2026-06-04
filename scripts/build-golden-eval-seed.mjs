#!/usr/bin/env node
/* eslint-disable */
/**
 * One-shot seed builder for the streamer-bot's golden eval set.
 *
 * Reads the scraped product corpus at `apps/server/data/scraped/*.json`
 * (the source of truth for the seeded DB) and writes a stratified
 * 200-entry seed file the worker reloads on start.
 *
 * Stratification: 50 entries per active mode
 *   { classic, higher-lower, comparison, bidding }
 * For higher-lower entries we synthesise a `referencePrice` by
 * jittering ±15% around the actual price.
 *
 * Determinism: products sorted by stable key, modes assigned by
 * round-robin within a sorted shuffle seeded from a fixed PRNG. Re-running
 * the script with the same inputs produces a byte-identical seed file —
 * which is the property the snapshot regression gate depends on (any
 * MAE drift across runs needs to come from model weights, not from the
 * eval set itself shifting under us).
 *
 * Usage:
 *   node scripts/build-golden-eval-seed.mjs                       # default --out infra/streamer/golden-eval.json
 *   node scripts/build-golden-eval-seed.mjs --out /tmp/g.json
 *   node scripts/build-golden-eval-seed.mjs --n 50                # smaller seed (12 per active mode)
 *   node scripts/build-golden-eval-seed.mjs --scraped some/dir    # alternate scraped path
 *
 * The committed seed at `infra/streamer/golden-eval.json` is shipped
 * inside the streamer docker image and copied into `<dataDir>/golden-eval.json`
 * by the entrypoint when the runtime file is absent.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Active modes post-PR-#326 (Phase 3d.2). budget-builder + price-match
 * are deprecated and excluded.
 */
const ACTIVE_MODES = ["classic", "higher-lower", "comparison", "bidding"];
const NEEDS_REF = new Set(["higher-lower", "closest-without-going-over"]);

const MIN_CENTS = 50;
const MAX_CENTS = 100_000;
const PRNG_SEED = 0x3e0b1d23;

function parseArgs(argv) {
  const out = {
    out: "infra/streamer/golden-eval.json",
    scraped: "apps/server/data/scraped",
    n: 200,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--n") out.n = Number(argv[++i]);
    else if (a === "--scraped") out.scraped = argv[++i];
  }
  return out;
}

/** Linear-congruential PRNG seeded for byte-stable output. */
function makePrng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}

function loadCorpus(scrapedDir) {
  const files = fs
    .readdirSync(scrapedDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const all = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(scrapedDir, f), "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      if (typeof r.title !== "string" || !r.title) continue;
      const price = r.price_cents ?? r.priceCents;
      if (typeof price !== "number" || !Number.isFinite(price)) continue;
      if (price < MIN_CENTS || price > MAX_CENTS) continue;
      all.push({
        // Deterministic numeric id from asin so the seed survives a
        // DB re-seed; the exact id never reaches a real game so any
        // stable hash works.
        id: hash32(r.asin ?? r.title),
        asin: r.asin,
        title: r.title,
        category: r.category ?? "uncategorized",
        imageUrl: r.image_url ?? r.imageUrl,
        priceCents: price,
      });
    }
  }
  // Stable sort: by asin then title — guarantees deterministic
  // selection across machines.
  all.sort((a, b) => {
    const ax = a.asin ?? "";
    const bx = b.asin ?? "";
    if (ax !== bx) return ax < bx ? -1 : 1;
    return a.title < b.title ? -1 : 1;
  });
  return all;
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const { out: outPath, n: total, scraped } = parseArgs(process.argv);
if (!fs.existsSync(scraped)) {
  console.error(`golden-eval-seed: scraped dir not found at ${scraped}`);
  process.exit(1);
}

const corpus = loadCorpus(scraped);
if (corpus.length < total) {
  console.error(
    `golden-eval-seed: corpus has ${corpus.length} eligible products, need ≥${total}`,
  );
  process.exit(1);
}

const rand = makePrng(PRNG_SEED);
// Fisher-Yates with the seeded PRNG so the same corpus + seed →
// the same shuffle every time.
const pool = [...corpus];
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}

const perMode = Math.floor(total / ACTIVE_MODES.length);
if (perMode * ACTIVE_MODES.length !== total) {
  console.error(
    `golden-eval-seed: --n=${total} not divisible by ${ACTIVE_MODES.length} active modes`,
  );
  process.exit(1);
}

const entries = [];
let cursor = 0;
for (const mode of ACTIVE_MODES) {
  for (let k = 0; k < perMode; k++) {
    const r = pool[cursor++];
    const entry = {
      product: {
        id: r.id,
        title: r.title,
        category: r.category,
        imageUrl: r.imageUrl,
      },
      mode,
      actualCents: r.priceCents,
    };
    if (NEEDS_REF.has(mode)) {
      // Reference price ±15% jitter, never below 50¢.
      const jitter = 0.85 + 0.3 * rand();
      entry.referencePrice = Math.max(50, Math.round(r.priceCents * jitter));
    }
    entries.push(entry);
  }
}

const computedAt = "2026-05-09T00:00:00.000Z"; // pinned to keep the file byte-stable across regen runs
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify({ version: 1, computedAt, entries }, null, 2) + "\n",
);
console.log(`golden-eval-seed: wrote ${entries.length} entries (${perMode}/mode) to ${outPath}`);
