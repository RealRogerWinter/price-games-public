/**
 * DISCOVER CURATED PRODUCTS
 *
 * Searches Google for curated Amazon product listicles/blogs,
 * extracts ASINs, scrapes each product, and auto-categorizes
 * based on title keywords into existing categories.
 *
 * Target: 300 unique new products.
 *
 * Usage: npx tsx src/pipeline/discover-curated.ts
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import db from "../db";

// ============================================================
// TYPES & UTILITIES (shared with main pipeline)
// ============================================================

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
  scraped_at: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DESKTOP_HEADER_ARGS = [
  "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "-H", "Accept-Language: en-US,en;q=0.9",
  "-H", "Accept-Encoding: identity",
  "-H", 'Sec-Ch-Ua: "Chromium";v="122"',
  "-H", "Sec-Ch-Ua-Mobile: ?0",
  "-H", 'Sec-Ch-Ua-Platform: "macOS"',
  "-H", "Sec-Fetch-Dest: document",
  "-H", "Sec-Fetch-Mode: navigate",
  "-H", "Sec-Fetch-Site: none",
  "-H", "Sec-Fetch-User: ?1",
  "-H", "Upgrade-Insecure-Requests: 1",
  "-b", "session-id=000-0000000-0000000",
];

function curlFetch(url: string, maxTime = 20): string {
  return execFileSync("curl", [
    "-s", "-L", "--max-time", String(maxTime),
    ...DESKTOP_HEADER_ARGS,
    url,
  ], { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
}

function isCaptcha(html: string): boolean {
  return html.includes("captcha") || html.includes("validateCaptcha");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .trim();
}

async function verifyImageUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    const len = parseInt(res.headers.get("content-length") || "0");
    return res.ok && len > 500;
  } catch {
    return false;
  }
}

// ============================================================
// ASIN EXTRACTION FROM ARTICLES
// ============================================================

function extractAsinsFromUrl(url: string): string[] {
  try {
    const html = curlFetch(url, 15);
    const dpPattern = /(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/g;
    const asins = new Set<string>();
    let m;
    while ((m = dpPattern.exec(html)) !== null) {
      asins.add(m[1]);
    }
    const affiliatePattern = /amazon\.com[^"'\s]*\/([A-Z0-9]{10})(?:\/|\?|"|')/g;
    while ((m = affiliatePattern.exec(html)) !== null) {
      if (/^B0[A-Z0-9]{8}$/.test(m[1])) asins.add(m[1]);
    }
    return Array.from(asins);
  } catch {
    return [];
  }
}

function googleSearch(query: string): string[] {
  try {
    const html = curlFetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=8`, 15);
    const urlPattern = /href="(https?:\/\/(?:www\.)?(?!google\.com)[^"]+)"/g;
    const urls: string[] = [];
    let m;
    while ((m = urlPattern.exec(html)) !== null) {
      const u = m[1];
      if (!u.includes("google.com") && !u.includes("webcache") && !u.includes("translate.google")
          && !u.includes("youtube.com") && !u.includes("amazon.com")) {
        urls.push(u);
      }
    }
    return [...new Set(urls)];
  } catch {
    return [];
  }
}

// ============================================================
// PRODUCT PAGE SCRAPER
// ============================================================

function scrapeProductPage(asin: string): { status: string; title?: string; image_url?: string; price_cents?: number } {
  try {
    const html = curlFetch(`https://www.amazon.com/dp/${asin}`, 20);
    if (isCaptcha(html)) return { status: "captcha" };
    if (html.includes("Page Not Found") || html.includes("dogsofamazon")) return { status: "not_found" };

    // Title
    let title = html.match(/<span id="productTitle"[^>]*>\s*(.*?)\s*<\/span>/s)?.[1]?.trim();
    if (!title) title = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1];
    if (!title) return { status: "no_data" };
    title = decodeHtmlEntities(title);

    // Skip junk titles
    if (title.toLowerCase().includes("seeing this ad") || title.toLowerCase().includes("esrb rating")
        || title.toLowerCase().includes("product certification") || title.length < 10) {
      return { status: "no_data" };
    }

    // Price
    const priceMatch = html.match(/class="a-price-whole">(\d[\d,]*)<.*?class="a-price-fraction">(\d+)/s)
      || html.match(/\$(\d[\d,]*)\.(\d{2})/);
    if (!priceMatch) return { status: "no_data" };
    const dollars = parseInt(priceMatch[1].replace(/,/g, ""));
    const cents = parseInt(priceMatch[2]);
    const priceCents = dollars * 100 + cents;
    if (priceCents < 100 || priceCents > 999999) return { status: "no_data" };

    // Image
    let imageUrl = html.match(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1];
    if (!imageUrl) {
      const og = html.match(/property="og:image"\s+content="(https:\/\/[^"]+)"/);
      if (og) imageUrl = og[1];
    }
    if (!imageUrl) {
      const landing = html.match(/"landingImageUrl"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
      if (landing) {
        const id = landing[1].match(/\/I\/([A-Za-z0-9+_-]+)\./)?.[1];
        if (id) imageUrl = `https://m.media-amazon.com/images/I/${id}._AC_SL1500_.jpg`;
      }
    }
    if (!imageUrl) return { status: "no_data" };

    return { status: "ok", title, image_url: imageUrl, price_cents: priceCents };
  } catch {
    return { status: "no_data" };
  }
}

// ============================================================
// AUTO-CATEGORIZATION
// ============================================================

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Electronics: ["bluetooth", "wireless", "usb", "charger", "speaker", "headphone", "earbuds", "monitor", "keyboard", "mouse", "webcam", "microphone", "streaming", "smart home", "echo", "alexa", "roku", "fire tv", "hdmi", "cable", "adapter", "ssd", "hard drive", "flash drive", "power bank", "dash cam"],
  Kitchen: ["kitchen", "cooking", "baking", "cookware", "pan ", "pot ", "skillet", "blender", "mixer", "knife", "cutting board", "utensil", "spatula", "whisk", "measuring cup", "food storage", "tupperware", "coffee maker", "kettle", "toaster", "waffle", "air fryer", "instant pot", "slow cooker", "dutch oven", "cast iron"],
  Fashion: ["shirt", "pants", "jeans", "jacket", "hoodie", "sweater", "dress", "skirt", "coat", "sneakers", "boots", "sandals", "socks", "underwear", "bra ", "belt", "scarf", "gloves", "hat ", "beanie", "sunglasses", "backpack", "handbag", "purse", "wallet", "tote bag"],
  Beauty: ["moisturizer", "serum", "cleanser", "sunscreen", "mascara", "lipstick", "foundation", "concealer", "blush", "eyeshadow", "makeup", "skincare", "hair dryer", "curling iron", "flat iron", "shampoo", "conditioner", "face mask", "exfoliant", "toner", "primer", "setting spray", "beauty blender", "brush set"],
  "Sports & Fitness": ["dumbbell", "kettlebell", "yoga mat", "resistance band", "protein", "pre-workout", "gym", "fitness tracker", "running shoe", "exercise", "weight", "barbell", "bench press", "treadmill", "rowing machine", "boxing", "jump rope", "foam roller", "massage gun", "pull up bar", "basketball", "football", "soccer", "baseball", "golf", "tennis", "swim"],
  "Home Decor": ["candle", "diffuser", "throw pillow", "blanket", "curtain", "rug", "mirror", "wall art", "frame", "vase", "lamp", "string lights", "tapestry", "plant", "succulent", "shelf", "clock", "wind chime", "neon sign", "incense"],
  Toys: ["lego", "board game", "card game", "puzzle", "plush", "stuffed animal", "action figure", "doll", "nerf", "play-doh", "toy", "squishmallow", "building blocks", "rc car", "drone toy"],
  Baby: ["baby", "infant", "toddler", "stroller", "car seat", "diaper", "pacifier", "bottle", "onesie", "nursery", "crib", "bassinet", "teether", "highchair", "baby monitor"],
  Pet: ["dog ", "cat ", "pet ", "puppy", "kitten", "leash", "collar", "dog bed", "cat tree", "litter", "aquarium", "fish tank", "bird cage", "chew toy", "pet food", "treats dog", "treats cat"],
  Foods: ["snack", "candy", "chocolate", "gummy", "jerky", "protein bar", "hot sauce", "seasoning", "spice", "coffee", "tea ", "matcha", "honey", "olive oil", "vinegar", "nuts", "chips", "crackers", "energy drink"],
  "Travel & Luggage": ["luggage", "suitcase", "carry-on", "packing cube", "travel pillow", "passport", "travel adapter", "toiletry bag", "duffel", "travel backpack", "neck pillow"],
  Automotive: ["car ", "auto", "dash cam", "floor mat", "car wash", "wiper", "tire", "car mount", "jump starter", "obd2", "car charger", "seat cover", "steering wheel"],
  Gaming: ["gaming chair", "gaming mouse", "gaming keyboard", "gaming headset", "controller", "ps5", "xbox", "nintendo", "steam deck", "vr headset", "capture card", "stream deck", "gaming monitor", "pc case"],
  Music: ["guitar", "ukulele", "keyboard piano", "drum", "microphone", "audio interface", "tuner", "capo", "drumstick", "vinyl record", "turntable", "harmonica", "midi controller", "amp ", "amplifier"],
  Furniture: ["desk", "chair", "sofa", "couch", "bed ", "mattress", "dresser", "bookshelf", "nightstand", "ottoman", "futon", "table", "bench", "recliner", "cabinet"],
  "Tools & Home Improvement": ["drill", "saw", "hammer", "screwdriver", "wrench", "pliers", "level", "tape measure", "multitool", "sander", "generator", "thermostat", "deadbolt", "paint sprayer"],
  "Health & Wellness": ["vitamin", "supplement", "probiotic", "omega", "protein powder", "blood pressure", "thermometer", "first aid", "heating pad", "humidifier", "toothbrush", "floss", "melatonin", "pain relief", "allergy"],
  Appliances: ["vacuum", "washer", "dryer", "refrigerator", "dishwasher", "microwave", "air purifier", "dehumidifier", "espresso machine", "bread maker", "ice maker", "steam mop", "robot vacuum"],
  "Office & School Supplies": ["pen ", "pencil", "notebook", "planner", "stapler", "printer", "label maker", "shredder", "binder", "folder", "marker", "highlighter", "desk organizer", "whiteboard", "bulletin board", "monitor stand"],
  "Cleaning & Household": ["cleaning", "swiffer", "mop ", "broom", "trash can", "laundry", "detergent", "disinfect", "sponge", "paper towel", "trash bag", "air freshener", "storage bin", "organizer bin"],
  Jewelry: ["necklace", "bracelet", "earring", "ring ", "pendant", "chain", "watch", "cufflink", "brooch", "anklet", "charm"],
  Costumes: ["costume", "cosplay", "halloween", "wig ", "cape ", "mask "],
  "Arts & Crafts": ["paint ", "brush", "canvas", "yarn", "crochet", "knitting", "embroidery", "sewing machine", "glue gun", "craft", "marker set", "colored pencil", "watercolor", "clay"],
  Figurines: ["figurine", "statue", "action figure", "funko pop", "collectible figure", "anime figure", "sculpture"],
  Collectibles: ["trading card", "pokemon card", "baseball card", "coin collection", "comic book", "booster box", "collector"],
  "Garden & Outdoor": ["grill", "fire pit", "patio", "garden", "lawn", "sprinkler", "hose", "pruner", "outdoor light", "bird feeder", "compost", "planter"],
  "Outdoor Recreation": ["hiking", "camping", "tent", "sleeping bag", "backpacking", "trekking", "kayak", "canoe", "climbing", "headlamp", "water filter", "camp stove"],
  "Phone & Tablet Accessories": ["phone case", "screen protector", "popsocket", "phone mount", "tablet case", "ipad case", "phone charger", "lightning cable", "phone stand", "phone grip", "magsafe"],
};

function categorizeProduct(title: string): string {
  const lower = title.toLowerCase();

  // Score each category
  let bestCategory = "Weird and Wonderful";
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw.trim())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

// ============================================================
// ASIN LIST — discovered from curated listicles via WebSearch
// ============================================================

function loadDiscoveredAsins(): string[] {
  const filePath = path.join(__dirname, "..", "..", "data", "discovered-asins.txt");
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split(/\s+/).map(s => s.trim()).filter(s => /^[A-Z0-9]{10}$/.test(s));
}

// ============================================================
// BACKUP & DB LOADING
// ============================================================

const BACKUP_DIR = path.join(__dirname, "..", "..", "data", "backup");

function saveBackup(category: string, products: ScrapedProduct[]): number {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const safeName = category.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const filePath = path.join(BACKUP_DIR, `${safeName}.json`);

  let existing: ScrapedProduct[] = [];
  if (fs.existsSync(filePath)) {
    try { existing = JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch {}
  }

  const seenAsins = new Set(existing.map((p) => p.asin));
  for (const p of products) {
    if (!seenAsins.has(p.asin)) { existing.push(p); seenAsins.add(p.asin); }
  }

  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  return existing.length;
}

function loadToDatabase(products: ScrapedProduct[]): { inserted: number; skipped: number } {
  try { db.exec("ALTER TABLE products ADD COLUMN scraped_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE products ADD COLUMN added_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE products ADD COLUMN verified INTEGER DEFAULT 0"); } catch {}

  const existingAsins = new Set<string>();
  const rows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of rows) existingAsins.add(r.asin);

  const insert = db.prepare(
    `INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active, scraped_at, added_at, verified)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`
  );

  const now = new Date().toISOString();
  let inserted = 0, skipped = 0;

  const tx = db.transaction((items: ScrapedProduct[]) => {
    for (const p of items) {
      if (existingAsins.has(p.asin)) { skipped++; continue; }
      existingAsins.add(p.asin);
      insert.run(p.asin, p.title, p.image_url, p.title, p.price_cents, p.category, p.scraped_at, now);
      inserted++;
    }
  });
  tx(products);
  db.pragma("wal_checkpoint(TRUNCATE)");

  return { inserted, skipped };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const TARGET = 300;
  let captchaCount = 0;

  // Load existing ASINs
  const existingAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) existingAsins.add(r.asin);

  // Also track titles for dedup
  const existingTitles = new Set<string>();
  const titleRows = db.prepare("SELECT title FROM products WHERE is_active = 1").all() as { title: string }[];
  for (const r of titleRows) existingTitles.add(r.title.toLowerCase().slice(0, 50));

  // Load ASINs from file (discovered via web search of curated listicles)
  const allAsins = loadDiscoveredAsins();
  const newAsins = allAsins.filter(a => !existingAsins.has(a));

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   CURATED LISTICLE DISCOVERY PIPELINE                    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`Target: ${TARGET} new unique products`);
  console.log(`Existing: ${existingAsins.size} ASINs in DB`);
  console.log(`Discovered ASINs: ${allAsins.length} total, ${newAsins.length} new\n`);

  if (newAsins.length === 0) {
    console.log("No new ASINs to scrape. Exiting.");
    return;
  }

  // Phase 2: Scrape each ASIN and auto-categorize
  console.log("═══ PHASE 2: Scraping & categorizing products ═══\n");

  const allProducts: ScrapedProduct[] = [];
  const asinList = newAsins;
  const categoryCounter: Record<string, number> = {};
  const BATCH_SIZE = 20; // Save to DB every 20 products
  let pendingBatch: ScrapedProduct[] = [];
  let totalInserted = 0;
  const MAX_CAPTCHA_PER_ASIN = 6; // Skip ASIN after 6 captcha attempts

  for (let i = 0; i < asinList.length && allProducts.length < TARGET; i++) {
    const asin = asinList[i];
    let asinRetries = 0;
    let scraped = false;

    while (!scraped && asinRetries < MAX_CAPTCHA_PER_ASIN) {
      process.stdout.write(`  [${i + 1}/${asinList.length}] ${asin}... `);
      const result = scrapeProductPage(asin);

      if (result.status === "captcha") {
        asinRetries++;
        console.log(`CAPTCHA (${asinRetries}/${MAX_CAPTCHA_PER_ASIN})`);
        if (asinRetries >= MAX_CAPTCHA_PER_ASIN) {
          console.log(`    Skipping ${asin} after ${MAX_CAPTCHA_PER_ASIN} captcha attempts`);
          break;
        }
        captchaCount++;
        if (captchaCount >= 3) {
          console.log("    Captcha wall — waiting 90s...");
          await sleep(90000);
          captchaCount = 0;
        } else {
          await sleep(15000);
        }
        continue;
      }

      scraped = true;
      captchaCount = 0;

      if (result.status !== "ok" || !result.title || !result.image_url || !result.price_cents) {
        console.log(result.status === "not_found" ? "404" : "NO DATA");
        break;
      }

      // Check for similar title
      const titleKey = result.title.toLowerCase().slice(0, 50);
      if (existingTitles.has(titleKey)) {
        console.log("SIMILAR TITLE — skip");
        break;
      }
      existingTitles.add(titleKey);

      // Auto-categorize
      const category = categorizeProduct(result.title);
      categoryCounter[category] = (categoryCounter[category] || 0) + 1;

      const product: ScrapedProduct = {
        asin,
        title: result.title,
        image_url: result.image_url,
        price_cents: result.price_cents,
        category,
        scraped_at: new Date().toISOString(),
      };

      allProducts.push(product);
      pendingBatch.push(product);
      console.log(`OK $${(result.price_cents / 100).toFixed(2)} → [${category}] "${result.title.slice(0, 50)}..."`);

      // Save batch incrementally
      if (pendingBatch.length >= BATCH_SIZE) {
        process.stdout.write(`\n  --- Saving batch of ${pendingBatch.length} products... `);
        // Verify images
        const verified: ScrapedProduct[] = [];
        for (const p of pendingBatch) {
          if (await verifyImageUrl(p.image_url)) verified.push(p);
        }
        // Save backup + DB
        const byCategory: Record<string, ScrapedProduct[]> = {};
        for (const p of verified) {
          if (!byCategory[p.category]) byCategory[p.category] = [];
          byCategory[p.category].push(p);
        }
        for (const [cat, prods] of Object.entries(byCategory)) saveBackup(cat, prods);
        const { inserted } = loadToDatabase(verified);
        totalInserted += inserted;
        console.log(`${verified.length}/${pendingBatch.length} verified, ${inserted} inserted (${totalInserted} total) ---\n`);
        pendingBatch = [];
      }
    }

    await sleep(6000 + Math.random() * 6000);
  }

  // Save remaining batch
  if (pendingBatch.length > 0) {
    process.stdout.write(`\n  --- Saving final batch of ${pendingBatch.length} products... `);
    const finalVerified: ScrapedProduct[] = [];
    for (const p of pendingBatch) {
      if (await verifyImageUrl(p.image_url)) finalVerified.push(p);
    }
    const finalByCategory: Record<string, ScrapedProduct[]> = {};
    for (const p of finalVerified) {
      if (!finalByCategory[p.category]) finalByCategory[p.category] = [];
      finalByCategory[p.category].push(p);
    }
    for (const [cat, prods] of Object.entries(finalByCategory)) saveBackup(cat, prods);
    const { inserted: finalInserted } = loadToDatabase(finalVerified);
    totalInserted += finalInserted;
    console.log(`${finalVerified.length}/${pendingBatch.length} verified, ${finalInserted} inserted (${totalInserted} total) ---\n`);
  }

  console.log(`\n  Scraped ${allProducts.length} products, ${totalInserted} inserted to DB\n`);

  // Summary
  console.log("\n══════════════════════════════════════════════════");
  console.log("DISCOVERY COMPLETE");
  console.log("══════════════════════════════════════════════════\n");
  console.log("Products by category:");
  const sorted = Object.entries(categoryCounter).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sorted) {
    console.log(`  ${cat.padEnd(28)} ${count}`);
  }
  console.log(`\n  Total scraped: ${allProducts.length}`);
  console.log(`  Inserted: ${totalInserted}`);
}

main().catch(console.error);
