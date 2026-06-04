#!/usr/bin/env node
/* eslint-disable */
/**
 * One-shot seed builder for the streamer-bot's brand-tier table.
 *
 * Strategy: read every product row out of the production DB, group by
 * lowercased category, and partition each group into terciles of
 * priceCents. Map (asin || lowercased title) → tier in {0,1,2}.
 *
 * Output: writes a `brand-tiers.json` file with the schema declared in
 * `packages/bot-streamer/src/learning/brandTierTable.ts`.
 *
 * Usage:
 *   node scripts/build-brand-tier-seed.mjs \
 *     --db /path/to/price-game.db \
 *     --out /var/streamer/data/brand-tiers.json
 *
 * Defaults:
 *   --db   apps/server/data/price-game.db
 *   --out  /tmp/brand-tiers.json
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = { db: "apps/server/data/price-game.db", out: "/tmp/brand-tiers.json" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
}

const { db: dbPath, out: outPath } = parseArgs(process.argv);
if (!fs.existsSync(dbPath)) {
  console.error(`brand-tier-seed: DB not found at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const rows = db
  .prepare(
    "SELECT id, asin, title, category, priceCents FROM products WHERE isActive = 1 AND isArchived = 0 AND priceCents > 0 AND title IS NOT NULL",
  )
  .all();

const byCategory = new Map();
for (const r of rows) {
  const cat = (r.category ?? "uncategorized").toLowerCase().trim();
  if (!byCategory.has(cat)) byCategory.set(cat, []);
  byCategory.get(cat).push(r);
}

const entries = [];
for (const [, list] of byCategory) {
  list.sort((a, b) => a.priceCents - b.priceCents);
  const n = list.length;
  if (n < 3) {
    // Too few to partition meaningfully; mark all mid.
    for (const r of list) entries.push({ key: keyFor(r), tier: 1 });
    continue;
  }
  const lo = Math.floor(n / 3);
  const hi = Math.floor((2 * n) / 3);
  for (let i = 0; i < n; i++) {
    const tier = i < lo ? 0 : i < hi ? 1 : 2;
    entries.push({ key: keyFor(list[i]), tier });
  }
}

function keyFor(r) {
  return (r.asin ?? r.title).toString().toLowerCase().trim();
}

const seed = {
  version: 1,
  computedAt: new Date().toISOString(),
  entries,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(seed, null, 2));
console.log(
  `brand-tier-seed: wrote ${entries.length} entries from ${rows.length} products into ${outPath}`,
);
