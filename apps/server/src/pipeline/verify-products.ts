import db from "../db";

/**
 * VERIFICATION: Checks all products in the database have:
 *   1. Valid image URLs that return HTTP 200 with >500 bytes
 *   2. Reasonable prices ($1 - $10,000)
 *   3. Titles that look real (>15 chars, not "Amazon.com")
 *
 * Usage:
 *   npx tsx src/pipeline/verify-products.ts              # verify all
 *   npx tsx src/pipeline/verify-products.ts --fix        # deactivate broken products
 *   npx tsx src/pipeline/verify-products.ts --category X # verify one category
 */

interface ProductRow {
  id: number;
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
  verified: number | null;
}

async function verifyImage(url: string): Promise<{ ok: boolean; size: number }> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const size = parseInt(res.headers.get("content-length") || "0");
    return { ok: res.ok && size > 500, size };
  } catch {
    return { ok: false, size: 0 };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const categoryFilter = args.find((a) => a.startsWith("--category="))?.split("=")[1]
    || (args.indexOf("--category") >= 0 ? args[args.indexOf("--category") + 1] : null);

  // Add columns if missing
  try { db.exec("ALTER TABLE products ADD COLUMN verified INTEGER DEFAULT 0"); } catch {}

  let query = "SELECT id, asin, title, image_url, price_cents, category, verified FROM products WHERE is_active = 1";
  const params: any[] = [];
  if (categoryFilter) {
    query += " AND category = ?";
    params.push(categoryFilter);
  }
  query += " ORDER BY id";

  const products = db.prepare(query).all(...params) as ProductRow[];
  console.log(`Verifying ${products.length} products${categoryFilter ? ` in "${categoryFilter}"` : ""}...\n`);

  const markVerified = db.prepare("UPDATE products SET verified = 1 WHERE id = ?");
  const markFailed = db.prepare("UPDATE products SET verified = 0 WHERE id = ?");
  const deactivate = db.prepare("UPDATE products SET is_active = 0 WHERE id = ?");

  let good = 0;
  let badImage = 0;
  let badPrice = 0;
  let badTitle = 0;
  const issues: string[] = [];

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const pct = ((i / products.length) * 100).toFixed(0);
    process.stdout.write(`\r[${pct}%] ${i + 1}/${products.length}`);

    let failed = false;

    // Check title
    if (!p.title || p.title.length < 15 || p.title.startsWith("Amazon.com")) {
      badTitle++;
      issues.push(`ID ${p.id}: bad title "${p.title?.slice(0, 40)}"`);
      failed = true;
    }

    // Check price
    if (!p.price_cents || p.price_cents < 100 || p.price_cents > 1000000) {
      badPrice++;
      issues.push(`ID ${p.id}: bad price ${p.price_cents} (${p.title?.slice(0, 40)})`);
      failed = true;
    }

    // Check image URL resolves
    if (!p.image_url || !p.image_url.startsWith("https://m.media-amazon.com/images/I/")) {
      badImage++;
      issues.push(`ID ${p.id}: bad image URL format`);
      failed = true;
    } else {
      const { ok, size } = await verifyImage(p.image_url);
      if (!ok) {
        badImage++;
        issues.push(`ID ${p.id}: image 404/tiny (${size}b) ${p.image_url}`);
        failed = true;
      }
    }

    if (failed) {
      markFailed.run(p.id);
      if (fix) deactivate.run(p.id);
    } else {
      markVerified.run(p.id);
      good++;
    }
  }

  db.pragma("wal_checkpoint(TRUNCATE)");

  console.log(`\r\n\n=== VERIFICATION RESULTS ===`);
  console.log(`Good:       ${good}`);
  console.log(`Bad image:  ${badImage}`);
  console.log(`Bad price:  ${badPrice}`);
  console.log(`Bad title:  ${badTitle}`);
  console.log(`Total:      ${products.length}`);

  if (fix) {
    console.log(`\nDeactivated ${badImage + badPrice + badTitle} broken products.`);
  }

  if (issues.length > 0) {
    console.log(`\nIssues (first 30):`);
    for (const issue of issues.slice(0, 30)) {
      console.log(`  - ${issue}`);
    }
    if (issues.length > 30) console.log(`  ... and ${issues.length - 30} more`);
  }
}

main().catch(console.error);
