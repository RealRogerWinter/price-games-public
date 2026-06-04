#!/usr/bin/env node
/**
 * One-shot conversion of web-app PNG assets to WebP.
 * Run from the repo root: node scripts/convert-home-icons-to-webp.mjs
 *
 * Converts each input PNG to a WebP at the same dimensions with quality 85
 * (lossy, near-visually-lossless for cartoon art). Emits the .webp alongside
 * the source. Does NOT delete the source — deletion is handled separately
 * by the commit that updates import statements.
 *
 * Processes two groups:
 *   1. TARGETS — the curated list of home/streak/mode icons (PR #179).
 *   2. WALK_DIRS — whole directories that are walked and converted
 *      en-masse (e.g. avatars/, where the 62 sticker PNGs live).
 */
import sharp from "sharp";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../apps/web/src/assets/", import.meta.url).pathname;

const TARGETS = [
  "daily-challenge.png",
  "streak-bronze.png",
  "streak-silver.png",
  "streak-gold.png",
  "streak-diamond.png",
  "streak-missed.png",
  "streak-today.png",
  "modes/bidding.png",
  "modes/budget-builder.png",
  "modes/chain-reaction.png",
  "modes/classic.png",
  "modes/comparison.png",
  "modes/higher-lower.png",
  "modes/market-basket.png",
  "modes/odd-one-out.png",
  "modes/price-match.png",
  "modes/random.png",
  "modes/riser.png",
  "modes/sort-it-out.png",
  "modes/underbid.png",
];

// Directories whose every top-level PNG should be converted.
const WALK_DIRS = ["avatars"];

async function walkPngs(dir) {
  const full = join(ROOT, dir);
  const entries = await readdir(full, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".png"))
    .map((e) => join(dir, e.name));
}

const allTargets = [...TARGETS];
for (const d of WALK_DIRS) {
  allTargets.push(...(await walkPngs(d)));
}

let savedTotal = 0;
for (const rel of allTargets) {
  const src = join(ROOT, rel);
  const dst = src.replace(/\.png$/, ".webp");
  let before;
  try {
    before = (await stat(src)).size;
  } catch {
    // Skip entries that have already been migrated — the PR that cut over
    // to WebP deletes the source PNG, so rerunning this script post-commit
    // is a no-op for that target rather than an error.
    continue;
  }
  await sharp(src).webp({ quality: 85, effort: 6 }).toFile(dst);
  const after = (await stat(dst)).size;
  savedTotal += before - after;
  const pct = (100 * (1 - after / before)).toFixed(1);
  console.log(`${rel.padEnd(36)} ${before.toString().padStart(7)}  ->  ${after.toString().padStart(6)}  (-${pct}%)`);
}
console.log(`\nTotal bytes saved: ${savedTotal}`);
