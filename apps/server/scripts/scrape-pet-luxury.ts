import { execSync } from "child_process";
import db from "../src/db";

/**
 * Scrapes specific Amazon products by ASIN for the "High-End Pet" category.
 * ASINs sourced from listicles about luxury/premium pet products.
 */

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

const CATEGORY = "High-End Pet";

// Curated ASINs from listicles — luxury, premium, high-end pet products
const ASIN_LIST: string[] = [
  // Premium Dog Beds & Furniture
  "B0D8YBRKYV", // MAVERICK Premium Orthopedic Dog Bed with Memory Foam
  "B081L38ZST", // IHAPPYDOG Luxury Faux Fur Orthopedic Dog Bed
  "B0CG6J6CZR", // Luxury Wooden Dog Kennel House with Roof

  // Luxury Cat Trees & Towers
  "B0FDWD75JW", // Modern Cat Tree Tower Solid Wood Multi-Level Boho
  "B0G2L1GFM2", // EMUST 50IN Heavy-Duty Modern Cat Tree Tower Luxury
  "B0G1YMS6G4", // Mewzoom 51" Modern Cat Tree Tower Natural Solid Wood
  "B0FVF3VD5Q", // Veehoo Wood Cat Tree Aesthetic Modern with Hammock

  // Pet Cameras & Treat Dispensers
  "B09GDQZLD1", // Furbo 360° Dog Camera Treat Tossing Pet Security Cam
  "B0C4XYGMF1", // Furbo Mini Pet Camera with Treat Toss
  "B0DHKRKJNM", // PETLIBRO Automatic Cat Feeder with Camera 1080P HD 5G WiFi

  // Smart Automatic Pet Feeders
  "B0938D9LD8", // Feeder-Robot by Whisker Smart Automatic Pet Feeder
  "B0B5ZGGWBQ", // PETLIBRO Automatic Cat Feeder with Camera
  "B098J4TCDB", // PETLIBRO Automatic Cat Food Dispenser for 2 Pets

  // Self-Cleaning Litter Boxes
  "B0FFDNZSHT", // Litter-Robot 4 Supply Bundle by Whisker
  "B09KC7Q4YF", // PETKIT PuraMax Self Cleaning Cat Litter Box
  "B08T9CCP1M", // PETKIT PuraX Self-Cleaning Litter Box
  "B0BZ4QJ6Y5", // PETKIT Open-Top & AI Camera Self Cleaning Litter Box

  // GPS Pet Trackers
  "B08M6H284G", // Tractive Smart Dog GPS Tracker with Virtual Fence
  "B0C2C5LP16", // Tractive XL Smart Dog GPS Tracker 1-Month Battery

  // Premium Pet Water Fountains
  "B0FMRCCR24", // PETLIBRO Dockstream 2 Smart App Monitoring Water Fountain
  "B0DK55S939", // Wireless Cat Water Fountain Stainless Steel 3.2L

  // Luxury Pet Carriers & Strollers
  "B07HYZGS53", // HPZ Pet Rover Prime 3-in-1 Luxury Dog/Cat Stroller
  "B0836MT47K", // VIAGDO Premium Heavy Duty Dog Stroller
  "B09K6P4TN6", // TouristPet Luxury Faux Leather Airline Approved Carrier
  "B0C4K1W4XW", // TSA Airline Approved PU Leather Luxury Pet Carrier

  // Premium Dog Harnesses
  "B01N10INNX", // Ruffwear Front Range Dog Harness Reflective Padded
  "B0041W936A", // Julius-K9 IDC Powerharness Dog Harness

  // Interactive Smart Toys & Ball Launchers
  "B00PG3LWDK", // iFetch Interactive Ball Launcher for Dogs
  "B0D7G196HB", // iFetch Too Automatic Ball Launcher Medium-Large Dogs

  // Pet DNA Test Kits
  "B01EINBA76", // Embark Breed & Health Kit Dog DNA Test
  "B09K1K89D1", // Wisdom Panel Premium Dog DNA Kit

  // Elevated Dog Bowls & Feeders
  "B0G1LZBPYG", // Premium Adjustable Height Ceramic Elevated Dog Bowl
  "B084KQW5GM", // WOOD & TAIL Designer Elevated Dog Feeder Handmade

  // Premium Grooming Tools
  "B0BRLBLGHW", // Coolaroo Pro Elevated Dog Bed
  "B096W65L7H", // Coolaroo On-The-Go Elevated Dog Bed Foldable Travel
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchProductPage(asin: string): string {
  const url = `https://www.amazon.com/dp/${asin}`;
  return execSync(
    [
      "curl -s -L --max-time 20",
      '-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"',
      '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"',
      '-H "Accept-Language: en-US,en;q=0.9"',
      '-H "Accept-Encoding: identity"',
      '-H "Sec-Ch-Ua: \\"Chromium\\";v=\\"131\\", \\"Not_A Brand\\";v=\\"24\\""',
      '-H "Sec-Ch-Ua-Mobile: ?0"',
      '-H "Sec-Ch-Ua-Platform: \\"Windows\\""',
      '-H "Sec-Fetch-Dest: document"',
      '-H "Sec-Fetch-Mode: navigate"',
      '-H "Sec-Fetch-Site: none"',
      '-H "Sec-Fetch-User: ?1"',
      '-H "Upgrade-Insecure-Requests: 1"',
      '-H "Cache-Control: max-age=0"',
      '-b "session-id=000-0000000-0000000"',
      `"${url}"`,
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

// Also search for luxury pet products to get more variety
const PET_SEARCHES = [
  "luxury dog bed orthopedic premium",
  "automatic pet feeder smart wifi camera",
  "premium cat tree tower modern wood",
  "pet camera treat dispenser wifi",
  "GPS pet tracker dog collar smart",
  "self cleaning litter box automatic",
  "luxury pet stroller premium dog",
  "premium dog harness no-pull",
  "smart pet water fountain stainless steel",
  "elevated dog bowl stand premium",
];

function fetchSearchPage(query: string): string {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.amazon.com/s?k=${encodedQuery}`;
  return execSync(
    [
      "curl -s -L --max-time 20",
      '-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"',
      '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"',
      '-H "Accept-Language: en-US,en;q=0.9"',
      '-H "Accept-Encoding: identity"',
      '-H "Sec-Ch-Ua: \\"Chromium\\";v=\\"131\\", \\"Not_A Brand\\";v=\\"24\\""',
      '-H "Sec-Ch-Ua-Mobile: ?0"',
      '-H "Sec-Ch-Ua-Platform: \\"Windows\\""',
      '-H "Sec-Fetch-Dest: document"',
      '-H "Sec-Fetch-Mode: navigate"',
      '-H "Sec-Fetch-Site: none"',
      '-H "Sec-Fetch-User: ?1"',
      '-H "Upgrade-Insecure-Requests: 1"',
      '-H "Cache-Control: max-age=0"',
      '-b "session-id=000-0000000-0000000"',
      `"${url}"`,
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
    if (!priceDollars || priceDollars <= 0 || priceDollars >= 2000) continue;
    const priceCents = Math.round(priceDollars * 100);

    products.push({ asin, title, image_url: imageUrl, price_cents: priceCents, category: CATEGORY });
  }

  return products;
}

async function main() {
  console.log(`=== High-End Pet Product Scraper ===\n`);

  // Load existing ASINs
  const existingAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) existingAsins.add(r.asin);
  console.log(`Existing products in DB: ${existingRows.length}`);

  const allProducts: ScrapedProduct[] = [];
  const seenAsins = new Set(existingAsins);
  let captchaCount = 0;

  // Phase 1: Scrape individual ASINs from listicles
  console.log(`\n--- Phase 1: Scraping ${ASIN_LIST.length} curated ASINs from listicles ---`);
  let scraped = 0;
  let failed = 0;

  for (const asin of ASIN_LIST) {
    if (seenAsins.has(asin)) {
      process.stdout.write(`  ${asin}: already in DB, skipping\n`);
      continue;
    }

    process.stdout.write(`  ${asin}: `);
    try {
      const html = fetchProductPage(asin);

      if (html.includes("captcha") || html.includes("validateCaptcha")) {
        captchaCount++;
        console.log("CAPTCHA!");
        if (captchaCount >= 3) {
          console.log("  Captcha wall — waiting 90s...");
          await sleep(90000);
          captchaCount = 0;
        } else {
          await sleep(15000);
        }
        continue;
      }
      captchaCount = 0;

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

    // 5-10s delay between individual fetches
    await sleep(5000 + Math.random() * 5000);
  }

  console.log(`\nPhase 1 complete: ${scraped} scraped, ${failed} failed`);

  // Phase 2: Search for more luxury pet products
  console.log(`\n--- Phase 2: Searching for more luxury pet products ---`);
  const targetTotal = 100;
  for (const query of PET_SEARCHES) {
    if (allProducts.length >= targetTotal) break;

    process.stdout.write(`  "${query}"... `);
    try {
      const html = fetchSearchPage(query);

      if (html.includes("captcha") || html.includes("validateCaptcha")) {
        captchaCount++;
        console.log("CAPTCHA!");
        if (captchaCount >= 3) {
          console.log("  Captcha wall — waiting 90s...");
          await sleep(90000);
          captchaCount = 0;
        } else {
          await sleep(15000);
        }
        continue;
      }
      captchaCount = 0;

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

    await sleep(8000 + Math.random() * 7000);
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
  const petCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }).c;
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;
  console.log(`\n"${CATEGORY}" category now has ${petCount} active products`);
  console.log(`Database total active products: ${totalCount}`);
  console.log("\nDone!");
}

main().catch(console.error);
