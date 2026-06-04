import { execSync } from "child_process";
import db from "../src/db";

/**
 * Scrapes specific Amazon products by ASIN for the "Collectibles" category.
 * ASINs sourced from Amazon best-seller lists, collector community recommendations,
 * and web searches for trading cards, coins, Funko Pops, figurines, etc.
 */

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

const CATEGORY = "Collectibles";

// Curated ASINs — collectibles: Funko Pops, trading cards, coins, figurines, etc.
const ASIN_LIST: string[] = [
  // Funko Pop Vinyl Figures
  "B0DGBZBJCC", // Funko Pop DC Superman 2025 - Superman
  "B0DGB5PDMB", // Funko Pop DC Superman 2025 - Krypto
  "B0DGBC77J5", // Funko Pop DC Superman 2025 - Lois Lane
  "B0DNRRLDRP", // Funko Pop Super Alien 2025 - Xenomorph
  "B0C6YSNMQ7", // Funko POP Comic Cover Marvel Deadpool Skrull
  "B08QXQQXBT", // Funko Pop Marvel Captain America Through Ages 5-Pack
  "B07TYQCV2L", // Funko Pop Marvel Fantastic Four The Thing
  "B0DDXVF241", // Funko Animation Bleach Ulquiorra 2024 Convention Exclusive
  "B0CXNJ1J55", // Funko Pop Last Ronin Comic Cover Target CON 2024

  // Pokemon Trading Cards
  "B0BKGX74WP", // Pokemon TCG Sealed 3-Booster Pack Lot
  "B0B6PYQY9G", // Pokemon TCG Pokemon GO Booster Pack
  "B0C6B6V2VK", // Pokemon TCG Authentic Factory Sealed Booster Pack
  "B01N0W6EP9", // Pokemon TCG Sun & Moon Booster Display Box
  "B01KXPZUF6", // Pokemon TCG XY Evolutions Sealed Booster Box

  // Yu-Gi-Oh Trading Cards
  "B0C2JJPNPL", // Yu-Gi-Oh Legendary Collection 25th Anniversary Box
  "B07GV8LRRT", // Yu-Gi-Oh 200 Mixed Trading Card Lot

  // Baseball / Sports Trading Cards
  "B0DSKDV7GP", // 2024 Topps Archives Baseball Sealed Hobby Box
  "B0D98TP9PQ", // 2024 Topps Baseball Complete Set Factory Sealed
  "B0DJG5W7B8", // 2024 Topps Update Baseball Sealed Hobby Box
  "B0CVNQB6KY", // 2024 Topps Series 1 Baseball Hobby Box
  "B0DCDP2RK3", // 2024 Topps Finest Baseball Sealed Hobby Box

  // Collectible Coins
  "B0FFP4RP86", // 2025 P D US Mint Uncirculated 20 Coin Set
  "B08DWP23NC", // Franklin Mint Founding Fathers 7-Piece Gold-Plated Coin Set
  "B07V6T6K2L", // Trump 2020 Gold & Silver Plated Coin Display Set
  "B0G8HL4C7G", // 6PCS Gold Plated Bitcoin Coins Commemorative Set
  "B082J4YR4G", // 1988 Olympic 2 Coin Set Proof Silver & Gold
  "B08JM7PKXK", // Large Pirate Coins 36 Bronze Silver Gold Treasure Set

  // Hot Wheels Collectible Cars
  "B0CNX8P16M", // Hot Wheels Premium Fast & Furious Die-Cast Car
  "B09NRWPX29", // Hot Wheels Premium Fast & Furious Bundle 5-Pack
  "B0B9Q3XYY2", // Hot Wheels Black Box 16 Die-Cast Cars
  "B0DFJFDLW4", // Hot Wheels Car-De-Asada Treasure Hunt Die-Cast
  "B0GPGW3H86", // Hot Wheels Ford Mustang GTD Super Treasure Hunt

  // Anime Collectible Figures
  "B0DQVC9ZHK", // Banpresto Naruto Shippuden Gamabunta Soft Vinyl Figure
  "B0BTKPBTRT", // Banpresto Naruto Shippuden Gaara Q Posket Figure
  "B0CM93TG88", // Banpresto Naruto Rock Lee Memorable Saga Figure
  "B0BGX9QXNV", // Banpresto Naruto Shippuden Hyuga Neji Vibration Stars

  // LEGO Collectible Sets
  "B0D8V1XKWK", // LEGO Minifigures Series 25 Full Set of 12
  "B0DJDDY334", // LEGO Speed Champions Ultimate Formula 1 Collector Pack
  "B01N1O0FES", // LEGO Icons Bumblebee Transformers
  "B0DJ1BM44M", // LEGO Icons Fountain Garden Building Set

  // Comic Book Collectibles
  "1779523254", // DC Versus Marvel Omnibus Hardcover
  "B0DQLNK6DJ", // Ultimate DC and Marvel Comic Book Value Pack 20 Comics
];

// Rotating user agents to reduce captcha rate
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
];

let uaIndex = 0;
function nextUA(): string {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  return ua;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchProductPage(asin: string): string {
  const url = `https://www.amazon.com/dp/${asin}`;
  const ua = nextUA();
  return execSync(
    [
      "curl -s -L --max-time 25",
      `'-H' 'User-Agent: ${ua}'`,
      `'-H' 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'`,
      `'-H' 'Accept-Language: en-US,en;q=0.5'`,
      `'-H' 'Accept-Encoding: identity'`,
      `'-H' 'Connection: keep-alive'`,
      `'-H' 'Upgrade-Insecure-Requests: 1'`,
      `'-H' 'Sec-Fetch-Dest: document'`,
      `'-H' 'Sec-Fetch-Mode: navigate'`,
      `'-H' 'Sec-Fetch-Site: none'`,
      `'-H' 'Sec-Fetch-User: ?1'`,
      `'${url}'`,
    ].join(" "),
    { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }
  );
}

function parseProductPage(html: string, asin: string): ScrapedProduct | null {
  // Extract title from <span id="productTitle"> or <title> tag
  let title = "";
  const titleMatch = html.match(/id="productTitle"[^>]*>\s*([^<]+)/);
  if (titleMatch) {
    title = titleMatch[1].trim().replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  } else {
    const metaTitleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (metaTitleMatch) {
      title = metaTitleMatch[1].replace(/ : Amazon\.com.*/, "").replace(/ - Amazon\.com.*/, "").trim();
    }
  }
  if (!title || title.length < 10) return null;

  // Extract image: look for main product image
  let imageUrl = "";
  // Try hiRes images in JS data
  const hiResMatch = html.match(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
  if (hiResMatch) {
    imageUrl = hiResMatch[1];
  } else {
    // Try landingImage
    const landingMatch = html.match(/id="landingImage"[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (landingMatch) {
      imageUrl = landingMatch[1];
    } else {
      // Try any high-quality Amazon image
      const imgMatch = html.match(/"large"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
      if (imgMatch) {
        imageUrl = imgMatch[1];
      }
    }
  }
  if (!imageUrl) return null;

  // Upgrade to high-res
  imageUrl = imageUrl
    .replace(/_AC_UY\d+_/, "_AC_SL1500_")
    .replace(/_AC_UL\d+_/, "_AC_SL1500_")
    .replace(/_SS\d+_/, "_AC_SL1500_")
    .replace(/_SX\d+_/, "_AC_SL1500_")
    .replace(/_SY\d+_/, "_AC_SL1500_");

  // Extract price
  let priceCents = 0;
  // Try various price patterns
  const pricePatterns = [
    /class="a-offscreen">\$([0-9,]+\.[0-9]{2})/,
    /"priceAmount"\s*:\s*"?([0-9,]+\.[0-9]{2})/,
    /priceToPay[^>]*>.*?<span[^>]*>\$([0-9,]+\.[0-9]{2})/s,
    /price[^>]*>\s*\$([0-9,]+\.[0-9]{2})/,
  ];
  for (const pattern of pricePatterns) {
    const m = html.match(pattern);
    if (m) {
      const dollars = parseFloat(m[1].replace(/,/g, ""));
      if (dollars > 0 && dollars < 5000) {
        priceCents = Math.round(dollars * 100);
        break;
      }
    }
  }
  if (!priceCents) return null;

  return {
    asin,
    title,
    image_url: imageUrl,
    price_cents: priceCents,
    category: CATEGORY,
  };
}

// Search queries for collectible products
const COLLECTIBLE_SEARCHES = [
  "funko pop vinyl figure exclusive",
  "trading card sealed box collectible",
  "collectible coin set gold silver",
  "limited edition figure statue anime",
  "sports memorabilia trading cards sealed",
  "Hot Wheels premium collectible treasure hunt",
  "LEGO collectible display set adults",
  "vintage collectible toy retro figure",
  "Pokemon cards elite trainer box",
  "collector edition board game premium",
];

function fetchSearchPage(query: string): string {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.amazon.com/s?k=${encodedQuery}`;
  const ua = nextUA();
  return execSync(
    [
      "curl -s -L --max-time 25",
      `'-H' 'User-Agent: ${ua}'`,
      `'-H' 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'`,
      `'-H' 'Accept-Language: en-US,en;q=0.5'`,
      `'-H' 'Accept-Encoding: identity'`,
      `'-H' 'Connection: keep-alive'`,
      `'-H' 'Upgrade-Insecure-Requests: 1'`,
      `'-H' 'Sec-Fetch-Dest: document'`,
      `'-H' 'Sec-Fetch-Mode: navigate'`,
      `'-H' 'Sec-Fetch-Site: none'`,
      `'-H' 'Sec-Fetch-User: ?1'`,
      `'${url}'`,
    ].join(" "),
    { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }
  );
}

function parseSearchResults(html: string): ScrapedProduct[] {
  const products: ScrapedProduct[] = [];
  const asinPattern = /data-asin="([A-Z0-9]{10})"/g;
  const asinPositions: Array<{ asin: string; start: number }> = [];
  let match;
  const seenAsins = new Set<string>();
  while ((match = asinPattern.exec(html)) !== null) {
    if (!seenAsins.has(match[1])) {
      seenAsins.add(match[1]);
      asinPositions.push({ asin: match[1], start: match.index });
    }
  }

  for (let i = 0; i < asinPositions.length; i++) {
    const { asin, start } = asinPositions[i];
    const end = i + 1 < asinPositions.length ? asinPositions[i + 1].start : start + 15000;
    const chunk = html.slice(start, Math.min(end, start + 15000));

    const imgMatch = chunk.match(/<img[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (!imgMatch) continue;
    let imageUrl = imgMatch[1]
      .replace(/_AC_UY\d+_/, "_AC_SL1500_")
      .replace(/_AC_UL\d+_/, "_AC_SL1500_")
      .replace(/_SS\d+_/, "_AC_SL1500_");

    const spanTexts = chunk.match(/<span[^>]*>([^<]{20,300})<\/span>/g) || [];
    let title = "";
    for (const s of spanTexts) {
      const text = s.replace(/<[^>]+>/g, "").trim();
      if (text.includes("bought in past") || text.includes("Overall Pick") ||
          text.includes("sustainability") || text.includes("certification") ||
          text.includes("Click to see") || text.includes("free of Amazon") ||
          text.startsWith("Products highlighted")) continue;
      const decoded = text.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
      if (decoded.length > title.length) title = decoded;
    }
    if (!title || title.length < 15) continue;

    const priceMatch = chunk.match(/a-offscreen">\$([0-9,]+\.[0-9]{2})/);
    if (!priceMatch) continue;
    const priceDollars = parseFloat(priceMatch[1].replace(/,/g, ""));
    if (!priceDollars || priceDollars <= 0 || priceDollars >= 500) continue;
    const priceCents = Math.round(priceDollars * 100);

    products.push({ asin, title, image_url: imageUrl, price_cents: priceCents, category: CATEGORY });
  }

  return products;
}

async function main() {
  console.log(`=== Collectibles Product Scraper ===\n`);

  // Load existing ASINs
  const existingAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) existingAsins.add(r.asin);
  console.log(`Existing products in DB: ${existingRows.length}`);

  const allProducts: ScrapedProduct[] = [];
  const seenAsins = new Set(existingAsins);
  let captchaCount = 0;
  let consecutiveCaptchas = 0;

  // Phase 1: Scrape individual ASINs from curated list, with retry
  console.log(`\n--- Phase 1: Scraping ${ASIN_LIST.length} curated ASINs (with retries) ---`);
  let scraped = 0;
  let failed = 0;

  // Build queue of ASINs to try (skip already in DB)
  const asinQueue = ASIN_LIST.filter(a => !seenAsins.has(a));
  const retriedAsins = new Set<string>();

  let qi = 0;
  while (qi < asinQueue.length) {
    const asin = asinQueue[qi];
    qi++;

    if (seenAsins.has(asin)) {
      continue;
    }

    process.stdout.write(`  ${asin}: `);
    try {
      const html = fetchProductPage(asin);

      if (html.includes("captcha") || html.includes("validateCaptcha")) {
        consecutiveCaptchas++;
        console.log("CAPTCHA!");

        // Re-queue for retry (once)
        if (!retriedAsins.has(asin)) {
          retriedAsins.add(asin);
          asinQueue.push(asin);
        }

        if (consecutiveCaptchas >= 3) {
          console.log("  Captcha wall — waiting 120s...");
          await sleep(120000);
          consecutiveCaptchas = 0;
        } else {
          await sleep(20000 + Math.random() * 10000);
        }
        continue;
      }
      consecutiveCaptchas = 0;

      const product = parseProductPage(html, asin);
      if (product) {
        seenAsins.add(asin);
        allProducts.push(product);
        scraped++;
        console.log(`OK - ${product.title.substring(0, 60)} ($${(product.price_cents / 100).toFixed(2)})`);
      } else {
        failed++;
        console.log("FAILED (no title/image/price)");
      }
    } catch (err: any) {
      failed++;
      console.log(`ERROR: ${err.message?.slice(0, 60)}`);
    }

    // Longer delay between fetches: 15-25s
    await sleep(15000 + Math.random() * 10000);
  }

  console.log(`\nPhase 1 complete: ${scraped} scraped, ${failed} failed`);

  // Phase 2: Search for more collectible products
  console.log(`\n--- Phase 2: Searching for more collectible products ---`);
  consecutiveCaptchas = 0;
  const targetTotal = 100;
  for (const query of COLLECTIBLE_SEARCHES) {
    if (allProducts.length >= targetTotal) break;

    process.stdout.write(`  "${query}"... `);
    try {
      const html = fetchSearchPage(query);

      if (html.includes("captcha") || html.includes("validateCaptcha")) {
        consecutiveCaptchas++;
        console.log("CAPTCHA!");
        if (consecutiveCaptchas >= 2) {
          console.log("  Captcha wall — waiting 120s...");
          await sleep(120000);
          consecutiveCaptchas = 0;
        } else {
          await sleep(25000);
        }
        continue;
      }
      consecutiveCaptchas = 0;

      const products = parseSearchResults(html);
      let added = 0;
      for (const p of products) {
        if (allProducts.length >= targetTotal) break;
        if (!seenAsins.has(p.asin)) {
          seenAsins.add(p.asin);
          allProducts.push(p);
          added++;
        }
      }
      console.log(`${products.length} found, +${added} new (${allProducts.length} total)`);
    } catch (err: any) {
      console.log(`ERROR: ${err.message?.slice(0, 60)}`);
    }

    await sleep(15000 + Math.random() * 10000);
  }

  console.log(`\n=== Scraping Complete ===`);
  console.log(`Total products collected: ${allProducts.length}`);

  if (allProducts.length === 0) {
    console.log("No new products to add.");
    process.exit(0);
  }

  // Verify images
  console.log("\nVerifying images...");
  const verifiedProducts: ScrapedProduct[] = [];
  for (const p of allProducts) {
    try {
      const res = await fetch(p.image_url, { method: "HEAD" });
      const len = parseInt(res.headers.get("content-length") || "0");
      if (res.ok && len > 500) {
        verifiedProducts.push(p);
      }
    } catch {
      // skip broken images
    }
  }
  console.log(`Verified images: ${verifiedProducts.length}/${allProducts.length} (dropped ${allProducts.length - verifiedProducts.length})`);

  // Insert into database
  console.log("\nInserting new products...");
  const insert = db.prepare(
    `INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );

  const insertMany = db.transaction((items: ScrapedProduct[]) => {
    for (const p of items) {
      insert.run(p.asin, p.title, p.image_url, p.title, p.price_cents, p.category);
    }
  });

  insertMany(verifiedProducts);

  // Final stats
  const collectibleCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }).c;
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;
  console.log(`\n"${CATEGORY}" category now has ${collectibleCount} active products`);
  console.log(`Database total active products: ${totalCount}`);
  console.log("\nDone!");
}

main().catch(console.error);
