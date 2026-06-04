import { execSync } from "child_process";
import db from "../src/db";

/**
 * Scrapes specific Amazon products by ASIN for the "Jewelry" category.
 * ASINs sourced from listicles about popular/bestselling Amazon jewelry.
 */

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

const CATEGORY = "Jewelry";

// Curated ASINs from listicles — popular jewelry: necklaces, rings, bracelets, earrings, watches
const ASIN_LIST: string[] = [
  // Necklaces
  "B07MHTWWSJ", // Custom Name Necklace Personalized 18K Gold Plated
  "B08C6YZMXN", // Fettero Tiny Gold Initial Heart Necklace Choker
  "B07JFDKH3N", // MiaBella Solid 925 Sterling Silver Cuban Link Curb Chain
  "B071DDXGYZ", // Leafael Infinity Love Heart Pendant Necklace Birthstone
  "B07Y4QPGX5", // SOULMEET Cameo Sunflower Heart Locket Necklace
  "B0BCQHSQRL", // Chesky Dainty Gold Necklace
  "B0CZH2117N", // Turandoss Heart Initial Necklace
  "B0BW4N9Q3J", // Pavoi Simulated Diamond Tennis Necklace
  "B0B56FHPCX", // Freekiss Herringbone Necklace
  "B0DQ8DFWS6", // Vojo Gold Bubble Letter Necklace
  "B082YJ6NMN", // Pavoi Heart Necklace
  "B08PC8LN6L", // Pavoi Chain Necklace
  "B0CXJ5NB3K", // SmileBelle Daisy Necklace
  "B071W3M2V4", // EFYTAL Generations Necklace for Grandma

  // Earrings
  "B06ZYHXNCV", // PAVOI 14K Yellow Gold Plated Infinity Hoop Earrings
  "B0CXTK7LRG", // Mumreues Gold Stud Earrings
  "B08YNNF5TZ", // Obidos Triple Huggie Earrings
  "B09BBVJ6BF", // BaubleStar Stone Drop Earrings
  "B00YGY28N8", // Amazon Collection Sterling Silver Vertical Bar Dangle Earrings
  "B0B2Q31T55", // Pavoi 14K Gold Chain Earrings
  "B0974KM9QT", // 17 Mile Gold Hoop Earrings Set
  "B0CKYLJ95B", // Tonluyax Half Ball Stud Earrings
  "B0D5JTHPTZ", // Pavoi Convertible Paperclip Link Huggie Hoop Earrings
  "B0D9NWBFZP", // Sherlove Drop Dangle Earrings
  "B01M64992E", // Pavoi Freshwater Cultured Pearl Earrings
  "B09GY75W7Y", // Adoyi Gold Hoop Earrings Set
  "B07L5SB439", // Disney Minnie Mouse Crystal Stud Earrings

  // Bracelets
  "B07TBN9JRJ", // PAVOI 14K Gold Plated Tennis Bracelet Cubic Zirconia
  "B06Y3PQ1DB", // Amazon Essentials Rose Gold Heart-Link Bracelet
  "B0813995CM", // Fesciory Leather Wrap Bracelet
  "B0CT7NX16Q", // Monozo Initial Bracelet
  "B0C2P72WY6", // DearMay Gold Bracelet Set
  "B0CMX8P2WW", // Adoyi Beaded Stretch Bracelets
  "B0BMWDV32V", // Swarovski Emily Tennis Bracelet
  "B0814Y1G6Z", // Swarovski Infinity Heart Bangle
  "B0DF6RS2TH", // Ettika Cuff Bracelet
  "B0CRN32KJ8", // Fossil Harlow Heart Station Bracelet
  "B093L2HQFK", // Mevecco Dainty Bracelet
  "B0895SS58L", // BTYSUN Inspirational Cuff Bangle Bracelet

  // Rings
  "B07CVKW1JZ", // Barzel Statement Ring
  "B082VLM5MX", // Pavoi Twisted Eternity Band
  "B0C4LHK5PP", // Mytys Cocktail Ring
  "B07BHZ6F55", // PAVOI Gold Plated Adjustable White Opal Stacking Ring
  "B071FNCD42", // JewelryPalace Princess Diana Gemstone Birthstone Ring
  "B014WC38NC", // Amazon Collection Platinum-Plated Sterling Silver Band Ring
  "B0CNV1H1DY", // Pavoi 14K Gold-Plated Chunky Statement Ring
  "B01MFF1DEY", // Pavoi Stackable Eternity Ring
  "B0DNMPL939", // Pavoi 14K Gold Plated Interlocked Stackable Rings
  "B085467QZV", // Hicarer 8 Pieces Vintage Punk Rings
  "B07S78QPHR", // FUNRUN JEWELRY 61PCS Knuckle Ring Set for Women

  // Watches & Misc
  "B0CSG7KQ54", // Nine West Bracelet Watch
  "B07SDB4JWP", // ThunderFit Men's Silicone Rings
  "B08KGR2X6D", // Barzel Flat Marina Link Anklet
  "B09Q28Q135", // PDWZNBA Friendship Bangle
  "B00UY46JLQ", // Betsey Johnson Woven Heart Layered Necklace
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
      '-H "Cache-Control: max-age=0"',
      '-H "Sec-Ch-Ua: \\"Chromium\\";v=\\"131\\", \\"Not_A Brand\\";v=\\"24\\""',
      '-H "Sec-Ch-Ua-Mobile: ?0"',
      '-H "Sec-Ch-Ua-Platform: \\"Windows\\""',
      '-H "Sec-Fetch-Dest: document"',
      '-H "Sec-Fetch-Mode: navigate"',
      '-H "Sec-Fetch-Site: none"',
      '-H "Sec-Fetch-User: ?1"',
      '-H "Upgrade-Insecure-Requests: 1"',
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

// Search queries for finding more jewelry products
const JEWELRY_SEARCHES = [
  "gold necklace women",
  "diamond earrings women",
  "sterling silver bracelet women",
  "fashion rings women",
  "pearl necklace classic",
  "cubic zirconia tennis bracelet",
  "huggie hoop earrings gold",
  "layered necklace set gold",
  "birthstone ring women",
  "charm bracelet women",
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
      '-H "Cache-Control: max-age=0"',
      '-H "Sec-Ch-Ua: \\"Chromium\\";v=\\"131\\", \\"Not_A Brand\\";v=\\"24\\""',
      '-H "Sec-Ch-Ua-Mobile: ?0"',
      '-H "Sec-Ch-Ua-Platform: \\"Windows\\""',
      '-H "Sec-Fetch-Dest: document"',
      '-H "Sec-Fetch-Mode: navigate"',
      '-H "Sec-Fetch-Site: none"',
      '-H "Sec-Fetch-User: ?1"',
      '-H "Upgrade-Insecure-Requests: 1"',
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
    if (!priceDollars || priceDollars <= 0 || priceDollars >= 500) continue;
    const priceCents = Math.round(priceDollars * 100);

    products.push({ asin, title, image_url: imageUrl, price_cents: priceCents, category: CATEGORY });
  }

  return products;
}

async function main() {
  console.log(`=== Jewelry Product Scraper ===\n`);

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

  // Phase 2: Search for more jewelry products
  console.log(`\n--- Phase 2: Searching for more jewelry products ---`);
  const targetTotal = 100;
  for (const query of JEWELRY_SEARCHES) {
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
  const jewelryCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }).c;
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;
  console.log(`\n"${CATEGORY}" category now has ${jewelryCount} active products`);
  console.log(`Database total active products: ${totalCount}`);
  console.log("\nDone!");
}

main().catch(console.error);
