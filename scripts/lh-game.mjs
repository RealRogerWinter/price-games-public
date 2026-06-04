#!/usr/bin/env node
/**
 * lh-game.mjs — Drive price.games into an active single-player or multiplayer
 * round with Puppeteer, then run Lighthouse on the in-progress page.
 *
 * PageSpeed Insights' default "navigation" mode reloads the URL fresh, so
 * it cannot measure a game that's already been set up. This script uses
 * Lighthouse's `timespan` mode by default, which captures metrics across a
 * scripted interaction window (e.g. "host clicks higher, round advances").
 *
 * Usage:
 *   node scripts/lh-game.mjs                                       # both scenarios, sandbox
 *   node scripts/lh-game.mjs --target=single                       # single-player only
 *   node scripts/lh-game.mjs --target=multi --url=https://price.games
 *   node scripts/lh-game.mjs --mode=snapshot --preset=desktop      # DOM/a11y/SEO snapshot
 *
 * Flags:
 *   --target=<single|multi|both>              Default: both
 *   --url=<base-url>                          Default: http://127.0.0.1:3002
 *   --mode=<timespan|snapshot|navigation>     Default: timespan
 *   --preset=<mobile|desktop>                 Default: mobile
 *   --out=<dir>                               Default: lighthouse-reports/
 *   --headful                                 Launch visible browser (debugging)
 *   --chrome=<path>                           Override chrome binary
 *   --rounds=<n>                              Interactions during timespan (default: 2)
 *   --help
 */

import puppeteer from 'puppeteer-core';
import lighthouse, { startTimespan, snapshot, generateReport } from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, ...rest] = a.slice(2).split('=');
    out[k] = rest.length === 0 ? true : rest.join('=');
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
if (argv.help) {
  const header = '/**\n';
  const src = await fs.readFile(fileURLToPath(import.meta.url), 'utf8');
  const doc = src.slice(src.indexOf(header)).split('*/')[0].replace(/^\s*\*\s?/gm, '');
  process.stdout.write(doc);
  process.exit(0);
}

const TARGET = String(argv.target || 'both');
const BASE_URL = String(argv.url || 'http://127.0.0.1:3002').replace(/\/$/, '');
const MODE = String(argv.mode || 'timespan');
const PRESET = String(argv.preset || 'mobile');
const OUT_DIR = path.resolve(REPO_ROOT, String(argv.out || 'lighthouse-reports'));
const HEADFUL = Boolean(argv.headful);
const ROUNDS = Math.max(1, Number(argv.rounds ?? 2));

function detectChrome() {
  const candidates = [
    '/snap/chromium/current/usr/lib/chromium-browser/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('No chrome binary found. Pass --chrome=/path/to/chrome');
}

const CHROME = argv.chrome ? String(argv.chrome) : detectChrome();

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  // Required for lighthouse CDP attach in snap-confined chromium
  '--disable-features=Translate,BackForwardCache',
];

const VIEWPORT_MOBILE = { width: 412, height: 823, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true };
const VIEWPORT_DESKTOP = { width: 1350, height: 940, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const VIEWPORT = PRESET === 'desktop' ? VIEWPORT_DESKTOP : VIEWPORT_MOBILE;

// ── Helpers ───────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d+Z$/, 'Z');
}

async function clickIfPresent(page, selector, { timeoutMs = 500 } = {}) {
  const el = await page.waitForSelector(selector, { timeout: timeoutMs, visible: true }).catch(() => null);
  if (!el) return false;
  await el.click().catch(() => {});
  return true;
}

async function launchBrowser() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADFUL ? false : 'new',
    args: LAUNCH_ARGS,
    defaultViewport: VIEWPORT,
  });
  return browser;
}

/**
 * Pre-seed localStorage so the cookie-consent banner doesn't show up and
 * intercept clicks. Must run before any navigation to BASE_URL.
 */
async function primeConsent(page) {
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem(
        'cookie_consent',
        JSON.stringify({ consented: true, necessary: true, analytics: false })
      );
    } catch {}
  });
}

async function dismissBannerIfPresent(page) {
  try {
    const banner = await page.$('.cookie-banner');
    if (!banner) return;
    await page.evaluate(() => {
      const btn = document.querySelector('.cookie-banner .cookie-btn-secondary');
      if (btn) btn.click();
    });
    await page.waitForSelector('.cookie-banner', { hidden: true, timeout: 2000 }).catch(() => {});
  } catch {}
}

function attachConsoleTap(page, tag) {
  page.on('pageerror', (err) => console.warn(`[${tag}] pageerror:`, err.message));
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (u.startsWith('data:') || u.includes('chrome-extension')) return;
    console.warn(`[${tag}] requestfailed: ${req.failure()?.errorText || '?'} ${u}`);
  });
  page.on('console', (msg) => {
    const t = msg.type();
    if (t !== 'error' && t !== 'warning') return;
    console.warn(`[${tag}] console.${t}:`, msg.text());
  });
}

async function dumpFailure(page, tag) {
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const shot = path.join(OUT_DIR, `fail-${tag}-${stamp()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.error(`[${tag}] url=${page.url()}  screenshot=${shot}`);
  } catch (e) {
    console.error(`[${tag}] failed to capture failure state: ${e?.message}`);
  }
}

async function saveReport(name, runnerResult) {
  if (!runnerResult) throw new Error(`Lighthouse produced no result for ${name}`);
  await fs.mkdir(OUT_DIR, { recursive: true });
  const s = stamp();
  const htmlPath = path.join(OUT_DIR, `${name}-${s}.html`);
  const jsonPath = path.join(OUT_DIR, `${name}-${s}.json`);
  await fs.writeFile(htmlPath, generateReport(runnerResult.lhr, 'html'));
  await fs.writeFile(jsonPath, generateReport(runnerResult.lhr, 'json'));

  const cats = runnerResult.lhr.categories || {};
  const score = (k) => {
    const v = cats[k]?.score;
    return typeof v === 'number' ? Math.round(v * 100) : null;
  };
  const metrics = runnerResult.lhr.audits || {};
  const metric = (k) => metrics[k]?.displayValue || metrics[k]?.numericValue || null;
  return {
    name,
    htmlPath,
    jsonPath,
    scores: {
      performance: score('performance'),
      accessibility: score('accessibility'),
      'best-practices': score('best-practices'),
      seo: score('seo'),
    },
    metrics: {
      FCP: metric('first-contentful-paint'),
      LCP: metric('largest-contentful-paint'),
      TBT: metric('total-blocking-time'),
      CLS: metric('cumulative-layout-shift'),
      SI: metric('speed-index'),
      INP: metric('interaction-to-next-paint'),
      TTI: metric('interactive'),
    },
  };
}

function lhConfig() {
  return PRESET === 'desktop' ? desktopConfig : undefined;
}

function lhFlags() {
  return { output: ['html', 'json'], logLevel: 'error' };
}

// ── Scenario drivers ─────────────────────────────────────────
async function setupSinglePlayer(page) {
  await primeConsent(page);
  console.log(`[single] goto ${BASE_URL}/`);
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await dismissBannerIfPresent(page);
  await page.waitForSelector('.mode-card.mode-higher-lower', { timeout: 30_000 });
  console.log('[single] click "Higher or Lower"');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null),
    page.click('.mode-card.mode-higher-lower'),
  ]);
  await page.waitForSelector('.product-card', { timeout: 60_000 });
  await page.waitForSelector('.btn-higher', { timeout: 30_000 });
  console.log('[single] in-game, ready to measure');
}

async function playSingleRound(page) {
  // Press higher; the round resolves and either a "Next" button or the next
  // product appears automatically after a short result animation.
  await clickIfPresent(page, '.btn-higher', { timeoutMs: 2000 });
  await delay(1200);
  // Some modes have a "Next" cta; advance if present.
  await clickIfPresent(page, '.btn.btn-primary', { timeoutMs: 800 });
  // Wait for the next product to be ready (ignore if the game just ended).
  await page.waitForSelector('.product-card', { timeout: 10_000 }).catch(() => {});
}

async function setupMultiplayer() {
  console.log('[multi] launching host browser');
  const browserA = await launchBrowser();
  const [pageA] = await browserA.pages();
  attachConsoleTap(pageA, 'host');
  await pageA.setViewport(VIEWPORT);
  await primeConsent(pageA);

  console.log(`[multi] host goto ${BASE_URL}/mp`);
  await pageA.goto(`${BASE_URL}/mp`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await dismissBannerIfPresent(pageA);
  await pageA.waitForSelector('.mp-hub-name-input', { timeout: 30_000 });
  await pageA.type('.mp-hub-name-input', 'HostBot');
  console.log('[multi] host clicks Create Room');
  await pageA.click('.mp-hub-card-btn--create');
  try {
    await pageA.waitForSelector('.lobby-code', { timeout: 30_000 });
  } catch (err) {
    await dumpFailure(pageA, 'host-no-lobby-code');
    throw err;
  }
  const code = (await pageA.$eval('.lobby-code', (el) => el.textContent || '')).trim().replace(/\s+/g, '');
  if (!code) throw new Error('Failed to read room code');
  console.log(`[multi] room code = ${code}`);

  console.log('[multi] launching guest browser');
  const browserB = await launchBrowser();
  const [pageB] = await browserB.pages();
  await pageB.setViewport(VIEWPORT);

  attachConsoleTap(pageB, 'guest');
  await primeConsent(pageB);
  console.log(`[multi] guest goto ${BASE_URL}/${code}`);
  await pageB.goto(`${BASE_URL}/${code}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await dismissBannerIfPresent(pageB);
  // Direct-join form uses .mp-hub-join-input; fallback to hub name input.
  const nameSelector = (await pageB.$('.mp-hub-join-input')) ? '.mp-hub-join-input' : '.mp-hub-name-input';
  await pageB.waitForSelector(nameSelector, { timeout: 30_000 });
  await pageB.type(nameSelector, 'GuestBot');
  await pageB.click('.mp-hub-join-btn');

  console.log('[multi] waiting for Start button to enable (host)');
  // The start button may or may not be disabled by default; wait for any
  // variant to be present and try clicking once lobby shows 2 players.
  await pageA.waitForFunction(
    () => {
      const roster = document.querySelectorAll('.lobby-player, [data-testid="lobby-player"], .mp-player-card');
      return roster.length >= 2;
    },
    { timeout: 30_000 }
  ).catch(() => null);
  await pageA.waitForSelector('.lobby-start-btn', { timeout: 30_000 });
  await delay(600); // allow disabled → enabled transition
  console.log('[multi] host clicks Start');
  await pageA.click('.lobby-start-btn');

  console.log('[multi] waiting for product on both screens');
  await Promise.all([
    pageA.waitForSelector('.product-card', { timeout: 60_000 }),
    pageB.waitForSelector('.product-card', { timeout: 60_000 }),
  ]);
  console.log('[multi] in-game, ready to measure');

  return { browserA, pageA, browserB, pageB, code };
}

async function playMultiRound(pageA, pageB) {
  // In MP, both players must submit before the round resolves. Fire in parallel.
  await Promise.all([
    clickIfPresent(pageA, '.btn-higher', { timeoutMs: 2000 }),
    clickIfPresent(pageB, '.btn-lower', { timeoutMs: 2000 }),
  ]);
  await delay(2000);
  await Promise.all([
    clickIfPresent(pageA, '.btn.btn-primary', { timeoutMs: 800 }),
    clickIfPresent(pageB, '.btn.btn-primary', { timeoutMs: 800 }),
  ]);
  await Promise.all([
    pageA.waitForSelector('.product-card', { timeout: 10_000 }).catch(() => {}),
    pageB.waitForSelector('.product-card', { timeout: 10_000 }).catch(() => {}),
  ]);
}

// ── Run a lighthouse pass on an already-set-up page ───────────
async function runLH(page, name, interact) {
  console.log(`[${name}] mode=${MODE} preset=${PRESET}`);
  const flags = lhFlags();
  const config = lhConfig();

  let result;
  if (MODE === 'timespan') {
    const { endTimespan } = await startTimespan(page, { flags, config });
    if (interact) await interact();
    result = await endTimespan();
  } else if (MODE === 'snapshot') {
    result = await snapshot(page, { flags, config });
  } else if (MODE === 'navigation') {
    // Re-navigates the current URL fresh. Loses "in-progress" state but
    // matches what PageSpeed Insights' public tool reports.
    result = await lighthouse(page.url(), flags, config);
  } else {
    throw new Error(`Unknown --mode=${MODE}`);
  }
  return saveReport(name, result);
}

// ── Entry points ─────────────────────────────────────────────
async function runSingle() {
  const browser = await launchBrowser();
  try {
    const [page] = await browser.pages();
    await page.setViewport(VIEWPORT);
    await setupSinglePlayer(page);
    return await runLH(page, `single-${PRESET}-${MODE}`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        console.log(`[single] interaction round ${i + 1}/${ROUNDS}`);
        await playSingleRound(page);
      }
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runMulti() {
  const { browserA, pageA, pageB, browserB } = await setupMultiplayer();
  try {
    return await runLH(pageA, `multi-${PRESET}-${MODE}`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        console.log(`[multi] interaction round ${i + 1}/${ROUNDS}`);
        await playMultiRound(pageA, pageB);
      }
    });
  } finally {
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
  }
}

function formatSummary(r) {
  const s = r.scores;
  const m = r.metrics;
  return [
    `── ${r.name} ──`,
    `  scores   : perf=${s.performance} a11y=${s.accessibility} best=${s['best-practices']} seo=${s.seo}`,
    `  metrics  : FCP=${m.FCP}  LCP=${m.LCP}  TBT=${m.TBT}  CLS=${m.CLS}  SI=${m.SI}`,
    `  report   : ${path.relative(REPO_ROOT, r.htmlPath)}`,
  ].join('\n');
}

async function main() {
  console.log(`lh-game: target=${TARGET} url=${BASE_URL} mode=${MODE} preset=${PRESET} rounds=${ROUNDS}`);
  console.log(`         chrome=${CHROME}`);
  console.log(`         out=${OUT_DIR}`);

  const results = [];
  if (TARGET === 'single' || TARGET === 'both') results.push(await runSingle());
  if (TARGET === 'multi' || TARGET === 'both') results.push(await runMulti());

  console.log('\n' + results.map(formatSummary).join('\n'));
}

main().catch((err) => {
  console.error('\nlh-game FAILED:', err?.stack || err);
  process.exit(1);
});
