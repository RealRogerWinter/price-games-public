import { execSync } from "child_process";
import db from "../src/db";

/**
 * Scrapes specific Amazon products by ASIN for the "Costumes" category.
 * ASINs sourced from listicles about popular Halloween, cosplay, inflatable, and funny costumes.
 */

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

const CATEGORY = "Costumes";

// Curated ASINs from listicles — costumes of all kinds
const ASIN_LIST: string[] = [
  // Inflatable Costumes
  "B00TO6E0T8", // Rubies Original T-Rex Inflatable Costume
  "B083K42JCS", // RHYTHMARTS Inflatable Dinosaur T-Rex Costume
  "B08Y5L6LG2", // One Casa Inflatable Dinosaur Riding T-Rex
  "B0D7BL2GN7", // KOOY Inflatable Elephant Costume
  "B09ZQV2ZHW", // KOOY Inflatable Riding Chicken Costume
  "B0D12LD6VV", // OurWarm Unicorn Inflatable Costume
  "B0CWGVBJ3Q", // Spooktacular Creations Sitting on Toilet Inflatable
  "B099HVTDT9", // Spooktacular Creations Inflatable Banana Costume
  "B08QZRKXQ2", // One Casa Inflatable Shark Costume Full Body
  "B0732WBK7M", // Qshine Inflatable Pumpkin Costume

  // Funny Food Costumes
  "B0088MGO3E", // Rasta Imposta Lightweight Banana Costume
  "B0B1M89KX3", // Spooktacular Creations Hot Dog Costume
  "B08GF2J57C", // Taco Sauce Hot Chili Pepper Packet Costume
  "B0CWGCTQ22", // JUST FOR PARTY Hot Dog Costume Unisex
  "B0FM7VP9MT", // EraSpooky Realistic Taco Costume
  "B07VQYH9TV", // Rasta Imposta Avocado Couples Costume

  // Piggyback / Ride-On Costumes
  "B09J1XY3YG", // Morph Wrestler Piggyback Costume
  "B07FSL9Q6Q", // Morph Serial Killer Piggyback Costume
  "B073DD3ZT4", // Morphsuits Frog Piggyback Costume

  // Classic / Character Costumes
  "B08DLT687S", // Disguise Harry Potter Gryffindor Robe Deluxe
  "B0B94HZJ5C", // Harry Potter Hogwarts Wizarding World Cloak
  "B0GF6X17D5", // Dicxoser Renaissance Medieval Pirate Costume
  "B0DG8HP6NW", // Verceco Mens Pirate Costume Renaissance Outfit
  "B0D17YPQJ9", // Mprocen Mens Pirate Costume Medieval Set
  "B0D3L7XLCN", // qnprt Adult Caveman Costume
  "B0D48BMQCS", // UIMLK Halloween Couples Costume Cosplay

  // Morphsuits / Bodysuits
  "B0D6C2ZF4J", // Morph Banana Costume Adult Banana Suit
  "B0CJJX5MDQ", // Fun Costumes Adult Peeled Banana Costume

  // Miscellaneous Fun
  "B0B2LPJW1B", // MXoSUM Inflatable Dinosaur Ride-On (Black)
  "B0DRLFYT97", // GOPRIME Dinosaur Astronaut Inflatable
  "B0F48831Z9", // QNRMS Hippo Inflatable Costume (Purple)
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchProductPage(asin: string): string {
  const url = `https://www.amazon.com/dp/${asin}`;
  const ua = randomUA();
  return execSync(
    [
      "curl -s -L --max-time 25",
      `'-H' 'User-Agent: ${ua}'`,
      `'-H' 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'`,
      `'-H' 'Accept-Language: en-US,en;q=0.9'`,
      `'-H' 'Accept-Encoding: identity'`,
      `'-H' 'Cache-Control: no-cache'`,
      `'-H' 'Sec-Fetch-Dest: document'`,
      `'-H' 'Sec-Fetch-Mode: navigate'`,
      `'-H' 'Sec-Fetch-Site: none'`,
      `'-H' 'Sec-Fetch-User: ?1'`,
      `'-H' 'Upgrade-Insecure-Requests: 1'`,
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

// Search queries for costume products
const COSTUME_SEARCHES = [
  "halloween costume adult funny",
  "inflatable dinosaur costume adult",
  "cosplay costume adult popular",
  "funny couples halloween costume",
  "inflatable alien abduction costume",
  "adult onesie costume halloween",
  "pirate costume adult men",
  "witch costume adult women halloween",
  "superhero costume adult",
  "animal onesie costume adult",
];

function fetchSearchPage(query: string): string {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.amazon.com/s?k=${encodedQuery}`;
  const ua = randomUA();
  return execSync(
    [
      "curl -s -L --max-time 25",
      `'-H' 'User-Agent: ${ua}'`,
      `'-H' 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'`,
      `'-H' 'Accept-Language: en-US,en;q=0.9'`,
      `'-H' 'Accept-Encoding: identity'`,
      `'-H' 'Cache-Control: no-cache'`,
      `'-H' 'Sec-Fetch-Dest: document'`,
      `'-H' 'Sec-Fetch-Mode: navigate'`,
      `'-H' 'Sec-Fetch-Site: none'`,
      `'-H' 'Sec-Fetch-User: ?1'`,
      `'-H' 'Upgrade-Insecure-Requests: 1'`,
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
  console.log(`=== Costumes Product Scraper ===\n`);

  // Load existing ASINs
  const existingAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) existingAsins.add(r.asin);
  console.log(`Existing products in DB: ${existingRows.length}`);

  const allProducts: ScrapedProduct[] = [];
  const seenAsins = new Set(existingAsins);
  let captchaCount = 0;
  let consecutiveCaptchas = 0;

  // Phase 1: Scrape individual ASINs from listicles
  console.log(`\n--- Phase 1: Scraping ${ASIN_LIST.length} curated ASINs from listicles ---`);
  let scraped = 0;
  let failed = 0;

  for (const asin of ASIN_LIST) {
    if (seenAsins.has(asin)) {
      process.stdout.write(`  ${asin}: already in DB, skipping\n`);
      continue;
    }

    // Try up to 2 attempts per ASIN
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        console.log(`  ${asin}: retry attempt ${attempt + 1}...`);
        await sleep(30000 + Math.random() * 30000);
      }

      process.stdout.write(`  ${asin}: `);
      try {
        const html = fetchProductPage(asin);

        if (html.includes("captcha") || html.includes("validateCaptcha")) {
          consecutiveCaptchas++;
          console.log("CAPTCHA!");
          if (consecutiveCaptchas >= 3) {
            console.log("  Captcha wall — waiting 120s...");
            await sleep(120000);
            consecutiveCaptchas = 0;
          } else {
            await sleep(20000 + Math.random() * 10000);
          }
          continue; // try next attempt
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
        break; // success or parse failure, move on
      } catch (err: any) {
        if (attempt === 1) {
          failed++;
          console.log(`ERROR: ${err.message?.slice(0, 60)}`);
        }
      }
    }

    // 8-15s delay between individual fetches (longer to avoid captcha)
    await sleep(8000 + Math.random() * 7000);
  }

  console.log(`\nPhase 1 complete: ${scraped} scraped, ${failed} failed`);

  // Phase 2: Search for more costume products
  console.log(`\n--- Phase 2: Searching for more costume products ---`);
  const targetTotal = 100;
  consecutiveCaptchas = 0;

  for (const query of COSTUME_SEARCHES) {
    if (allProducts.length >= targetTotal) break;

    process.stdout.write(`  "${query}"... `);
    try {
      const html = fetchSearchPage(query);

      if (html.includes("captcha") || html.includes("validateCaptcha")) {
        consecutiveCaptchas++;
        console.log("CAPTCHA!");
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

    await sleep(10000 + Math.random() * 10000);
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
  const costumeCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }).c;
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;
  console.log(`\n"${CATEGORY}" category now has ${costumeCount} active products`);
  console.log(`Database total active products: ${totalCount}`);
  console.log("\nDone!");
}

main().catch(console.error);
