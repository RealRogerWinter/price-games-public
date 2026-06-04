import { execSync } from "child_process";
import db from "../src/db";

/**
 * Fix-images script: scrapes real Amazon product images one at a time.
 * For each product with a broken image (< 1KB), scrapes the Amazon page for the real image URL.
 * Updates the DB when successful.
 */

interface ProductRow {
  id: number;
  asin: string;
  image_url: string;
  title: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrapeImageUrl(asin: string): string | null {
  try {
    const html = execSync(
      [
        "curl -s -L --max-time 12",
        '-H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"',
        '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"',
        '-H "Accept-Language: en-US,en;q=0.9"',
        '-H "Accept-Encoding: identity"',
        '-H "Sec-Ch-Ua: \\"Chromium\\";v=\\"122\\""',
        '-H "Sec-Fetch-Dest: document"',
        '-H "Sec-Fetch-Mode: navigate"',
        '-H "Sec-Fetch-Site: none"',
        '-H "Sec-Fetch-User: ?1"',
        '-H "Upgrade-Insecure-Requests: 1"',
        '-b "session-id=000-0000000-0000000"',
        `"https://www.amazon.com/dp/${asin}"`,
      ].join(" "),
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    // Check for captcha
    if (html.includes("captcha") || html.includes("validateCaptcha")) {
      return "CAPTCHA";
    }

    // Check for 404
    if (html.includes("Page Not Found") || html.includes("dogsofamazon")) {
      return "NOT_FOUND";
    }

    const hiRes = html.match(/"hiRes":"(https:\/\/[^"]+)"/);
    if (hiRes) return hiRes[1];
    const large = html.match(/"large":"(https:\/\/[^"]+)"/);
    if (large) return large[1];
    const og = html.match(/property="og:image"\s+content="(https:\/\/[^"]+)"/);
    if (og) return og[1];

    return null;
  } catch {
    return null;
  }
}

async function main() {
  const products = db
    .prepare("SELECT id, asin, image_url, title FROM products ORDER BY id")
    .all() as ProductRow[];

  console.log(`Checking ${products.length} products for broken images...\n`);

  // First, identify which images are broken
  const broken: ProductRow[] = [];
  for (const p of products) {
    try {
      const res = await fetch(p.image_url, { method: "HEAD" });
      const len = parseInt(res.headers.get("content-length") || "0");
      if (!res.ok || len < 1000) {
        broken.push(p);
      }
    } catch {
      broken.push(p);
    }
  }

  console.log(`Found ${broken.length} products with broken images.\n`);

  const update = db.prepare("UPDATE products SET image_url = ? WHERE id = ?");
  let fixed = 0;
  let captchaCount = 0;
  const MAX_CONSECUTIVE_CAPTCHA = 5;

  for (let i = 0; i < broken.length; i++) {
    const p = broken[i];
    process.stdout.write(`[${i + 1}/${broken.length}] ${p.asin} (${p.title.slice(0, 40)})... `);

    const result = scrapeImageUrl(p.asin);

    if (result === "CAPTCHA") {
      captchaCount++;
      console.log("CAPTCHA");
      if (captchaCount >= MAX_CONSECUTIVE_CAPTCHA) {
        console.log(`\nHit ${MAX_CONSECUTIVE_CAPTCHA} consecutive CAPTCHAs. Waiting 60s before retrying...`);
        await sleep(60000);
        captchaCount = 0;
        i--; // retry this one
        continue;
      }
      await sleep(10000);
      continue;
    }

    captchaCount = 0; // reset on non-captcha

    if (result === "NOT_FOUND") {
      console.log("INVALID ASIN (404)");
      // Mark as inactive
      db.prepare("UPDATE products SET is_active = 0 WHERE id = ?").run(p.id);
    } else if (result) {
      update.run(result, p.id);
      fixed++;
      console.log(`FIXED -> ${result.split("/").pop()}`);
    } else {
      console.log("NO IMAGE FOUND");
    }

    // Random delay 6-12 seconds
    const delay = 6000 + Math.random() * 6000;
    await sleep(delay);
  }

  console.log(`\n=== Done ===`);
  console.log(`Fixed: ${fixed}/${broken.length}`);

  // Show final stats
  const activeCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;
  console.log(`Active products remaining: ${activeCount}`);
}

main().catch(console.error);
