/**
 * Parallel enrichment pipeline runner using Claude Code CLI as the AI provider.
 *
 * Architecture:
 *   - Products processed in batches of BATCH_SIZE concurrently
 *   - Phase 1: Pre-seed ALL web search queries for the entire batch in parallel
 *   - Phase 2: Run enrichment functions (materials → supply_chain → history) per product
 *   - Each product's enrichment steps run sequentially (data depends on prior step)
 *   - But multiple products run in parallel within the batch
 *   - spawn-based async claude CLI calls with concurrency limiting for searches
 *
 * Usage:
 *   node scripts/run-enrichment.js [--batch N] [--step materials|supply_chain|history|all] [--limit N]
 */

const { spawn } = require("child_process");
const Database = require("better-sqlite3");
const path = require("path");

const { enrichMaterials, enrichSupplyChain, enrichHistory } = require("../apps/server/dist/services/universe/enrichment");
const { computeSimilarity } = require("../apps/server/dist/services/universe/similarity");
const { computeGalaxyPositions } = require("../apps/server/dist/services/universe/galaxy");
const webSearchModule = require("../apps/server/dist/services/universe/webSearch");

const DB_PATH = path.join(__dirname, "../apps/server/data/price-game.db");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_CONCURRENCY = 8; // Max concurrent web search CLI calls

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}
const BATCH_SIZE = Math.min(Math.max(parseInt(getArg("batch") || "6", 10) || 6, 1), 20);
const STEP = getArg("step") || "all";
const LIMIT = parseInt(getArg("limit") || "0", 10) || 0;

// ---------- Spawn-based async claude CLI ----------

function spawnClaude(prompt, cliArgs) {
  return new Promise((resolve, reject) => {
    // Strip CLAUDECODE from env to avoid "nested session" errors when
    // this script is launched from within a Claude Code session.
    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE;
    const proc = spawn("claude", cliArgs, {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("timeout 5m")); }, 300000);
    proc.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exit ${code}: ${stderr.substring(0, 100)}`));
      resolve(stdout);
    });
    proc.on("error", err => { clearTimeout(timer); reject(err); });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function callClaude(prompt, { allowedTools = "", maxTurns = 1 } = {}) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const cliArgs = ["-p", "--output-format", "json", "--max-turns", String(maxTurns)];
      if (allowedTools) cliArgs.push("--allowedTools", allowedTools);
      const stdout = await spawnClaude(prompt, cliArgs);
      const jsonStart = stdout.indexOf("{");
      if (jsonStart < 0) throw new Error("No JSON");
      const parsed = JSON.parse(stdout.substring(jsonStart));
      if (parsed.is_error) throw new Error(parsed.result || "error");
      if (typeof parsed.result === "string") return parsed.result;
      if (parsed.result == null) throw new Error("null result");
      return String(parsed.result);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, (2 + attempt * 3) * 1000));
    }
  }
}

// ---------- Web Search with concurrency limiting ----------

function getCached(db, query) {
  const row = db.prepare("SELECT result_json FROM pu_search_cache WHERE query = ? AND expires_at > datetime('now')").get(query);
  return row ? JSON.parse(row.result_json) : null;
}

async function webSearch(db, query) {
  const cached = getCached(db, query);
  if (cached) return cached;
  try {
    const raw = await callClaude(
      `Search the web for: ${query}\n\nReturn ONLY a valid JSON array (no markdown) of up to 5 objects: {"title":string,"url":string,"snippet":string}. If nothing, return [].`,
      { allowedTools: "WebSearch", maxTurns: 3 }
    );
    let s = raw.trim();
    const cbm = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (cbm) s = cbm[1].trim();
    const i = s.indexOf("[");
    if (i >= 0) s = s.substring(i);
    const results = JSON.parse(s);
    const exp = new Date(Date.now() + CACHE_TTL_MS).toISOString();
    db.prepare("INSERT OR REPLACE INTO pu_search_cache (query, result_json, cached_at, expires_at) VALUES (?, ?, datetime('now'), ?)").run(query, JSON.stringify(results), exp);
    return results;
  } catch (err) { console.error(`[Search] "${query.substring(0, 60)}" failed:`, err.message); return []; }
}

/**
 * Run async tasks with a concurrency limit.
 * @param {Array} items - Items to process
 * @param {number} concurrency - Max concurrent tasks
 * @param {Function} fn - Async function to run on each item
 * @returns {Promise<Array>} Results in order
 */
async function parallelLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Pre-seed the search cache for all products and steps in a batch.
 * Collects all unique queries, filters out cached ones, then runs
 * uncached queries with concurrency limiting.
 */
async function preseedBatch(db, batch) {
  // Collect all queries across all products and steps
  const allQueries = [];
  for (const { product, steps } of batch) {
    for (const step of steps) {
      const queries = webSearchModule.buildSearchQueries(product.title, product.manufacturer, step);
      for (const q of queries) allQueries.push(q);
    }
  }

  // Deduplicate and filter out already-cached
  const unique = [...new Set(allQueries)];
  const uncached = unique.filter(q => !getCached(db, q));

  if (uncached.length === 0) return { total: unique.length, searched: 0 };

  // Run uncached searches with concurrency limit
  await parallelLimit(uncached, SEARCH_CONCURRENCY, async (query) => {
    await webSearch(db, query);
  });

  return { total: unique.length, searched: uncached.length };
}

// ---------- AI Provider ----------

function createAI() {
  return {
    async generateText(messages) {
      const prompt = messages.map(m => `[${m.role}]\n${m.content}`).join("\n\n");
      return { text: await callClaude(prompt), inputTokens: 0, outputTokens: 0 };
    },
    async generateStructured(messages, schema) {
      const schemaStr = `CRITICAL: Respond with ONLY valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
      const sys = messages.find(m => m.role === "system");
      const rest = messages.filter(m => m.role !== "system");
      const parts = [`[SYSTEM]\n${sys ? sys.content + "\n\n" : ""}${schemaStr}`];
      for (const m of rest) parts.push(`[${m.role.toUpperCase()}]\n${m.content}`);
      const raw = await callClaude(parts.join("\n\n"));
      let s = raw.trim();
      const cbm = s.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (cbm) s = cbm[1].trim();
      const idx = s.indexOf("{");
      if (idx > 0) s = s.substring(idx);
      return { data: JSON.parse(s), inputTokens: 0, outputTokens: 0 };
    },
  };
}

// Monkey-patch searchWeb to use pre-seeded cache
webSearchModule.searchWeb = async function(db, query) {
  const row = db.prepare("SELECT result_json FROM pu_search_cache WHERE query = ? AND expires_at > datetime('now')").get(query);
  return row ? JSON.parse(row.result_json) : [];
};

// ---------- Per-product pipeline ----------

async function enrichProduct(db, ai, product, steps) {
  const parts = [];
  if (steps.has("materials")) {
    await enrichMaterials(db, ai, product.id);
    parts.push(`${db.prepare("SELECT COUNT(*) as c FROM pu_product_materials WHERE product_id=?").get(product.id).c}mat`);
  }
  if (steps.has("supply_chain")) {
    await enrichSupplyChain(db, ai, product.id);
    parts.push(`${db.prepare("SELECT COUNT(*) as c FROM pu_supply_chain_nodes WHERE product_id=?").get(product.id).c}sc`);
  }
  if (steps.has("history")) {
    await enrichHistory(db, ai, product.id);
    parts.push(`${db.prepare("SELECT LENGTH(pu_history) as l FROM products WHERE id=?").get(product.id).l}ch`);
  }
  return parts.join(", ");
}

// ---------- Main ----------

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const ai = createAI();

  const products = db.prepare(
    "SELECT id, title, category, manufacturer FROM products WHERE pu_enriched=1 AND is_active=1 ORDER BY id"
  ).all();

  const doStep = s => STEP === "all" || STEP === s;
  const stepsToRun = new Set();
  if (doStep("materials")) stepsToRun.add("materials");
  if (doStep("supply_chain")) stepsToRun.add("supply_chain");
  if (doStep("history")) stepsToRun.add("history");

  const hasMat = new Set(db.prepare("SELECT DISTINCT product_id FROM pu_product_materials").all().map(r => r.product_id));
  const hasSC = new Set(db.prepare("SELECT DISTINCT product_id FROM pu_supply_chain_nodes").all().map(r => r.product_id));
  const hasHist = new Set(db.prepare(`SELECT id FROM products WHERE pu_history LIKE '{%"narrative"%'`).all().map(r => r.id));

  let work = products.map(p => {
    const steps = new Set();
    if (stepsToRun.has("materials") && !hasMat.has(p.id)) steps.add("materials");
    if (stepsToRun.has("supply_chain") && !hasSC.has(p.id)) steps.add("supply_chain");
    if (stepsToRun.has("history") && !hasHist.has(p.id)) steps.add("history");
    return { product: p, steps };
  }).filter(w => w.steps.size > 0);

  if (LIMIT > 0 && work.length > LIMIT) {
    work = work.slice(0, LIMIT);
  }

  console.log(`=== Parallel Enrichment (batch=${BATCH_SIZE}, search_concurrency=${SEARCH_CONCURRENCY}) ===`);
  console.log(`${work.length} products need work (${products.length - work.length} complete)`);
  console.log(`Steps: ${[...stepsToRun].join(", ")}\n`);

  let done = 0, errors = 0;
  const t0 = Date.now();

  // Process in fixed batches
  for (let i = 0; i < work.length; i += BATCH_SIZE) {
    const batch = work.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(work.length / BATCH_SIZE);

    // Phase 1: Pre-seed ALL web searches for this batch in parallel
    const searchT0 = Date.now();
    const { total: queryCount, searched: newSearches } = await preseedBatch(db, batch);
    const searchMs = Date.now() - searchT0;
    console.log(`  [Batch ${batchNum}/${totalBatches}] Pre-seeded ${newSearches}/${queryCount} queries in ${(searchMs/1000).toFixed(1)}s`);

    // Phase 2: Run enrichment for all products in batch in parallel
    const results = await Promise.allSettled(
      batch.map(async ({ product, steps }) => {
        const info = await enrichProduct(db, ai, product, steps);
        return { product, info };
      })
    );
    for (const r of results) {
      done++;
      if (r.status === "fulfilled") {
        console.log(`✓ [${done}/${work.length}] ${r.value.product.title.substring(0, 48)} — ${r.value.info}`);
      } else {
        errors++;
        console.log(`✗ [${done}/${work.length}] ERROR — ${r.reason?.message?.substring(0, 80)}`);
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n⏱ ${done - errors} ok, ${errors} failed in ${elapsed}s`);

  // Similarity & Galaxy
  if (doStep("similarity")) {
    console.log("\n━━━ Similarity ━━━");
    for (const p of products) computeSimilarity(db, p.id);
    console.log(`✓ ${db.prepare("SELECT COUNT(*) as c FROM pu_product_similarity").get().c} pairs`);
  }
  if (doStep("galaxy")) {
    console.log("\n━━━ Galaxy ━━━");
    computeGalaxyPositions(db);
    console.log(`✓ ${db.prepare("SELECT COUNT(*) as c FROM pu_galaxy_positions").get().c} positions`);
  }

  console.log("\n═══ Summary ═══");
  const s = q => db.prepare(q).get().c;
  console.log(`  Materials: ${s("SELECT COUNT(DISTINCT product_id) as c FROM pu_product_materials")} products, ${s("SELECT COUNT(*) as c FROM pu_product_materials")} links`);
  console.log(`  Supply chain: ${s("SELECT COUNT(DISTINCT product_id) as c FROM pu_supply_chain_nodes")} products, ${s("SELECT COUNT(*) as c FROM pu_supply_chain_nodes")} nodes`);
  console.log(`  History: ${s("SELECT COUNT(*) as c FROM products WHERE pu_history LIKE '{%\"narrative\"%'")} products`);
  console.log(`  Sources: ${s("SELECT COUNT(*) as c FROM pu_sources")} | Cache: ${s("SELECT COUNT(*) as c FROM pu_search_cache")}`);
  console.log(`  Similarity: ${s("SELECT COUNT(*) as c FROM pu_product_similarity")} | Galaxy: ${s("SELECT COUNT(*) as c FROM pu_galaxy_positions")}`);

  db.close();
  console.log("\nDone!");
}

main().catch(err => {
  console.error("Fatal:", err);
  try { new Database(DB_PATH).close(); } catch {}
  process.exit(1);
});
