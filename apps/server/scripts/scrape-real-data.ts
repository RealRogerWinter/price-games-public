/**
 * Batch scraper: fetches real title, price, and image URL from Amazon
 * for every product in the database. Uses mobile UA + --compressed curl.
 *
 * Usage: npx tsx src/scrape-real-data.ts
 *
 * Adds a 1-2 second delay between requests to avoid rate limiting.
 */

import { execSync } from "child_process";
import db from "../src/db";

interface ProductRow {
  id: number;
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
}

function scrapeAmazon(asin: string): { title: string; priceCents: number; imageUrl: string } | null {
  try {
    const html = execSync(
      [
        "curl -s -L --compressed --max-time 15",
        '-H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"',
        '-H "Accept: text/html,application/xhtml+xml"',
        '-H "Accept-Language: en-US,en;q=0.9"',
        '-b "session-id=000-0000000-0000000"',
        `"https://www.amazon.com/dp/${asin}"`,
      ].join(" "),
      { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }
    );

    // Title: from <title> tag, strip Amazon suffix
    const titleMatch = html.match(/<title[^>]*>([^<]+)/);
    let title = titleMatch ? titleMatch[1] : "";
    title = title
      .replace(/ : Amazon\.com.*/, "")
      .replace(/ - Amazon\.com.*/, "")
      .replace(/Amazon\.com:\s*/, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();

    // Price: first a-offscreen price (the main displayed price)
    const priceMatch = html.match(/a-offscreen">\$([0-9]+\.[0-9]{2})/);
    const priceDollars = priceMatch ? parseFloat(priceMatch[1]) : 0;
    const priceCents = Math.round(priceDollars * 100);

    // Image: from landingImageUrl JSON field, or first product image
    let imgId = "";
    const landingMatch = html.match(/"landingImageUrl"\s*:\s*"https:\/\/m\.media-amazon\.com\/images\/I\/([A-Za-z0-9+_-]+)\./);
    if (landingMatch) {
      imgId = landingMatch[1];
    } else {
      // Fallback: first product image with _AC_UF prefix
      const fallbackMatch = html.match(/https:\/\/m\.media-amazon\.com\/images\/I\/([A-Za-z0-9+_-]+)\._AC_UF/);
      if (fallbackMatch) imgId = fallbackMatch[1];
    }

    const imageUrl = imgId ? `https://m.media-amazon.com/images/I/${imgId}._AC_SL1500_.jpg` : "";

    if (!title || !priceCents || !imageUrl) return null;

    return { title, priceCents, imageUrl };
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const products = db.prepare("SELECT id, asin, title, image_url, price_cents FROM products ORDER BY id").all() as ProductRow[];
  console.log(`Total products to scrape: ${products.length}`);

  const update = db.prepare(
    "UPDATE products SET title = ?, price_cents = ?, image_url = ? WHERE id = ?"
  );

  let success = 0;
  let failed = 0;
  let blocked = 0;

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const pct = ((i / products.length) * 100).toFixed(1);
    process.stdout.write(`[${pct}%] ${i + 1}/${products.length} ASIN ${p.asin}... `);

    const result = scrapeAmazon(p.asin);

    if (result) {
      update.run(result.title, result.priceCents, result.imageUrl, p.id);
      console.log(`OK $${(result.priceCents / 100).toFixed(2)} "${result.title.substring(0, 60)}..."`);
      success++;
    } else {
      console.log("FAILED");
      failed++;
    }

    // Random delay 1-2 seconds to avoid rate limiting
    const delay = 1000 + Math.random() * 1000;
    await sleep(delay);

    // If we get 5 failures in a row, we're probably being blocked
    if (failed > 0 && failed % 5 === 0) {
      const recentFails = products.slice(Math.max(0, i - 4), i + 1).length;
      console.log(`  Warning: ${failed} total failures. Pausing 10s...`);
      await sleep(10000);
    }
  }

  // Checkpoint WAL
  db.pragma("wal_checkpoint(TRUNCATE)");

  console.log(`\n=== DONE ===`);
  console.log(`Success: ${success}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${products.length}`);
}

main();
