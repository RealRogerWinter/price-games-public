/**
 * Lipsync diagnostic probe.
 *
 * Drives a sandbox URL with `?broadcast=1&pcmtest=1`, captures all
 * `[pcm-test]` console output, and reads the two diagnostic globals
 * (`window.__pgPcmStats`, `window.__pgVisemeStats`) after the
 * synthetic 4-phase utterance finishes.
 *
 * Usage:
 *   node scripts/diag-lipsync.mjs [url]
 *
 * Default URL: http://localhost:3003/?broadcast=1&pcmtest=1
 */
import { chromium } from "playwright";

const URL = process.argv[2] ?? "http://localhost:3003/?broadcast=1&pcmtest=1";

// `--no-sandbox` is required when this script runs inside the
// CI / Docker context where the parent already provides isolation;
// don't copy this flag into other Playwright scripts without a
// matching constraint.
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const consoleLines = [];
page.on("console", (msg) => {
  const text = msg.text();
  if (text.startsWith("[pcm-test]")) {
    consoleLines.push(text);
    process.stdout.write(`  ${text}\n`);
  }
});
page.on("pageerror", (err) => {
  process.stdout.write(`  PAGEERR ${err.message}\n`);
});

console.log(`> goto ${URL}`);
await page.goto(URL, { waitUntil: "domcontentloaded" });

// The test now runs on click (so AudioContext autoplay policy doesn't
// gate the audio). Click the synthetic-PCM button once it renders.
await page.getByRole("button", { name: "Synthetic PCM" }).click({ timeout: 10_000 });

// The test posts `[pcm-test] done` at the end. Poll up to 20s.
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && !consoleLines.some((l) => l === "[pcm-test] done")) {
  await new Promise((r) => setTimeout(r, 200));
}

const finalStats = await page.evaluate(() => ({
  pcm: globalThis.__pgPcmStats ?? null,
  viseme: globalThis.__pgVisemeStats ?? null,
}));

console.log("\n=== Final stats ===");
console.log("pcm:", JSON.stringify(finalStats.pcm, null, 2));
console.log("viseme:", JSON.stringify(finalStats.viseme, null, 2));

const finished = consoleLines.some((l) => l === "[pcm-test] done");
console.log(finished ? "\n[ok] test sequence ran to completion" : "\n[warn] test did not signal done within 20s");

await browser.close();
process.exit(finished ? 0 : 1);
