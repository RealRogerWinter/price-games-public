import { execSync } from "child_process";
import db from "../src/db";

/**
 * Scrapes Amazon SEARCH RESULTS pages to get real product data.
 * One search page = ~20 products with ASIN, title, price, and image.
 * Much more efficient than scraping individual product pages.
 */

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

// Search queries mapped to our game categories — highly diverse, 1-2 items per query
const CATEGORY_SEARCHES: Record<string, string[]> = {
  Electronics: [
    "record player turntable vinyl",
    "e-reader kindle paperwhite",
    "digital photo frame wifi",
    "label maker portable",
    "walkie talkie long range",
    "mini projector portable",
    "electric guitar beginner",
    "microphone usb podcast",
    "calculator scientific",
    "cable modem router combo",
    "graphics card gpu",
    "printer inkjet wireless",
    "surge protector tower",
    "digital kitchen thermometer",
    "electric pencil sharpener",
    "radio shortwave portable",
    "karaoke machine bluetooth",
    "VR headset meta quest",
    "electronic drum pad",
    "TV antenna indoor hdtv",
    "NAS network storage",
    "oscilloscope handheld",
    "soldering iron station",
    "UPS battery backup",
    "radar detector car",
  ],
  "Home & Kitchen": [
    "bidet toilet seat attachment",
    "ice cream maker machine",
    "dehydrator food fruit",
    "bread machine automatic",
    "juicer cold press",
    "rice cooker japanese",
    "mandoline slicer kitchen",
    "compost bin countertop",
    "wine opener electric",
    "spice grinder electric",
    "paper towel holder stand",
    "shower curtain fabric",
    "trash can touchless",
    "humidifier cool mist",
    "air purifier bedroom",
    "electric can opener",
    "garlic press stainless",
    "salad spinner large",
    "meat thermometer wireless",
    "carpet cleaner portable",
    "sous vide precision cooker",
    "tortilla press cast iron",
    "cotton candy machine",
    "popcorn machine stovetop",
    "fondue set chocolate",
  ],
  "Beauty & Personal Care": [
    "jade roller face massager",
    "eyelash curler heated",
    "beard trimmer men",
    "curling iron wand",
    "bath bomb gift set",
    "face mask sheet pack",
    "dry shampoo spray",
    "nail clipper set manicure",
    "scalp massager shampoo brush",
    "nose hair trimmer",
    "face roller ice",
    "cotton pads reusable",
    "makeup mirror lighted",
    "foot spa massager",
    "dermaplaning tool face",
    "hair oil argan serum",
    "blackhead remover tool",
    "tanning lotion self tanner",
    "lip gloss set variety",
    "eyebrow pencil waterproof",
    "electric foot file",
    "hair clips claw large",
    "travel toiletry bag",
    "dental water flosser",
    "silk pillowcase mulberry",
  ],
  "Sports & Outdoors": [
    "kayak inflatable",
    "skateboard complete adult",
    "badminton set outdoor",
    "binoculars compact",
    "rock climbing harness",
    "punching bag freestanding",
    "ab roller wheel",
    "GPS handheld hiking",
    "surfboard foam beginner",
    "hammock camping portable",
    "lacrosse stick",
    "frisbee disc golf set",
    "archery bow and arrow",
    "ice skates adult",
    "kettlebell vinyl coated",
    "roller blades inline skates",
    "snorkel mask full face",
    "soccer ball official",
    "ping pong paddle set",
    "trampoline mini rebounder",
    "climbing chalk bag",
    "headlamp rechargeable bright",
    "ski goggles snow",
    "paddleboard inflatable",
    "balance board wooden",
  ],
  "Toys & Games": [
    "chess set wooden",
    "rubik cube speed",
    "telescope kids beginner",
    "microscope kids science",
    "model train set",
    "yo-yo professional",
    "kaleidoscope toy",
    "magic trick set kids",
    "rock tumbler polisher",
    "finger paint kids washable",
    "etch a sketch classic",
    "spirograph design set",
    "kinetic sand mold",
    "slinky original metal",
    "lite brite classic",
    "foam dart blaster gun",
    "wooden train set",
    "play kitchen accessories food",
    "bead maze activity cube",
    "kite large easy fly",
    "dominoes double twelve set",
    "toy piano keyboard kids",
    "water gun super soaker",
    "pogo stick kids",
    "detective spy kit kids",
  ],
  "Clothing & Fashion": [
    "tie silk men necktie",
    "cufflinks men set",
    "swim trunks men board shorts",
    "yoga pants women bootcut",
    "fanny pack crossbody",
    "reading glasses blue light",
    "slippers memory foam",
    "robe women fleece",
    "apron kitchen cooking",
    "compression socks women",
    "beanie winter knit",
    "messenger bag canvas",
    "flip flops men leather",
    "bow tie men adjustable",
    "cardigan women oversized",
    "duffel bag gym travel",
    "snow boots men waterproof",
    "earrings women gold hoop",
    "bracelet leather men",
    "umbrella windproof automatic",
    "suspenders men heavy duty",
    "clutch purse evening",
    "bucket hat cotton",
    "kimono robe women satin",
    "steel toe work boots",
  ],
  "Pet Supplies": [
    "reptile terrarium kit",
    "hamster cage habitat",
    "aquarium filter canister",
    "bird cage large parakeet",
    "horse treats natural",
    "chicken coop nesting box",
    "dog life jacket swim",
    "cat backpack carrier",
    "automatic pet feeder timer",
    "dog agility training kit",
    "fish food flakes tropical",
    "turtle dock floating",
    "rabbit hay feeder",
    "dog poop bag dispenser",
    "cat calming diffuser",
    "pet stairs dog ramp",
    "gecko terrarium supplies",
    "dog dental chew toy",
    "cat window perch",
    "puppy training pads",
    "parrot perch stand",
    "dog cooling mat summer",
    "flea collar cat dog",
    "pet nail grinder electric",
    "hermit crab shells",
  ],
  "Tools & Home Improvement": [
    "table saw portable",
    "router woodworking trim",
    "jigsaw power tool",
    "angle grinder 4 inch",
    "heat gun paint stripper",
    "multimeter digital voltmeter",
    "pipe wrench plumbing",
    "circular saw cordless",
    "wire strippers electrical",
    "rivet gun pop riveter",
    "clamp bar woodworking",
    "air compressor portable",
    "tile cutter manual",
    "sander orbital palm",
    "utility knife retractable",
    "chainsaw electric",
    "soldering torch propane",
    "chisel set wood carving",
    "doorbell camera wireless",
    "thermostat smart programmable",
    "motion sensor light outdoor",
    "ceiling fan modern",
    "dimmer switch led",
    "weather station indoor outdoor",
    "dehumidifier basement",
  ],
  "Grocery & Gourmet": [
    "matcha green tea powder",
    "balsamic vinegar aged",
    "coconut oil organic",
    "vanilla extract pure",
    "sriracha hot chili sauce",
    "peanut butter natural",
    "sea salt flakes finishing",
    "instant ramen variety pack",
    "dark chocolate bar 70%",
    "almond flour blanched",
    "chia seeds organic",
    "bone broth organic",
    "mac and cheese gourmet",
    "soy sauce premium",
    "tahini sesame paste",
    "canned tuna wild caught",
    "pickles dill kosher",
    "jam preserves variety",
    "quinoa organic",
    "oat milk barista",
    "espresso capsules nespresso",
    "miso paste white",
    "hot cocoa mix gourmet",
    "crackers artisan sourdough",
    "dried mango slices",
  ],
  "Baby & Kids": [
    "kids headphones volume limiting",
    "toddler backpack animal",
    "baby nail trimmer electric",
    "kids rain boots",
    "baby spoon silicone set",
    "white noise machine baby",
    "potty training toilet seat",
    "baby knee pads crawling",
    "kids lunch box insulated",
    "baby thermometer forehead",
    "toddler bed rail guard",
    "baby nasal aspirator",
    "children art easel",
    "kids bike helmet",
    "baby sun hat upf",
    "toddler utensils fork spoon",
    "baby laundry detergent",
    "kids water table outdoor",
    "baby humidifier nursery",
    "children bookshelf storage",
    "baby sleep sack wearable",
    "kids walkie talkie toy",
    "baby bouncer seat",
    "toddler shoes first walker",
    "kids tent play house",
  ],
  Automotive: [
    "OBD2 scanner diagnostic",
    "car battery jump starter",
    "tire pressure gauge digital",
    "car paint scratch remover",
    "blind spot mirror",
    "car roof rack cross bars",
    "steering wheel lock anti theft",
    "car escape tool",
    "windshield repair kit",
    "car bluetooth FM transmitter",
    "license plate frame",
    "car seat gap filler",
    "wheel cleaning brush",
    "car hood scoop vent",
    "tonneau cover truck bed",
    "hitch bike rack",
    "car polisher buffer",
    "winter windshield wiper blades",
    "car key signal blocker",
    "engine oil synthetic 5w30",
    "car LED interior lights",
    "ceramic coating spray",
    "portable air compressor car",
    "car cup holder expander",
    "GPS tracker vehicle",
  ],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchSearchPage(query: string): string {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.amazon.com/s?k=${encodedQuery}`;

  return execSync(
    [
      "curl -s -L --max-time 20",
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
      `"${url}"`,
    ].join(" "),
    { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }
  );
}

function parseSearchResults(html: string, category: string): ScrapedProduct[] {
  const products: ScrapedProduct[] = [];

  // Split HTML by data-asin to get individual product blocks
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

    // Extract image: <img src="https://m.media-amazon.com/images/I/...">
    const imgMatch = chunk.match(/<img[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (!imgMatch) continue;
    // Upgrade thumbnail to high-res
    let imageUrl = imgMatch[1]
      .replace(/_AC_UY\d+_/, "_AC_SL1500_")
      .replace(/_AC_UL\d+_/, "_AC_SL1500_")
      .replace(/_SS\d+_/, "_AC_SL1500_");

    // Extract title: longest <span> text content (>20 chars, product names are long)
    const spanTexts = chunk.match(/<span[^>]*>([^<]{20,300})<\/span>/g) || [];
    let title = "";
    for (const s of spanTexts) {
      const text = s.replace(/<[^>]+>/g, "").trim();
      // Skip non-product text
      if (text.includes("bought in past") || text.includes("Overall Pick") ||
          text.includes("sustainability") || text.includes("recycled") ||
          text.includes("certification") || text.includes("Check each") ||
          text.includes("Click to see") || text.includes("free of Amazon") ||
          text.includes("certified by Amazon") || text.includes("small business brands") ||
          text.includes("commitment to empowering") || text.includes("Shop products from") ||
          text.includes("Carbon emissions from") || text.includes("lifecycle of this product") ||
          text.startsWith("Products highlighted")) continue;
      // Decode HTML entities
      const decoded = text.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
      if (decoded.length > title.length) {
        title = decoded;
      }
    }
    if (!title || title.length < 15) continue;

    // Extract price: first $XX.XX from a-offscreen spans
    const priceMatch = chunk.match(/a-offscreen">\$([0-9,]+\.[0-9]{2})/);
    if (!priceMatch) continue;
    const priceDollars = parseFloat(priceMatch[1].replace(/,/g, ""));
    if (!priceDollars || priceDollars <= 0) continue;
    const priceCents = Math.round(priceDollars * 100);

    products.push({
      asin,
      title,
      image_url: imageUrl,
      price_cents: priceCents,
      category,
    });
  }

  return products;
}

const TARGET_PER_CATEGORY = 100;

async function main() {
  const newProducts: ScrapedProduct[] = [];
  let captchaCount = 0;

  // Load existing ASINs from DB to avoid duplicates
  const existingAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) existingAsins.add(r.asin);

  // Count existing per category
  const existingByCategory: Record<string, number> = {};
  const catCounts = db.prepare("SELECT category, COUNT(*) as c FROM products WHERE is_active = 1 GROUP BY category").all() as { category: string; c: number }[];
  for (const r of catCounts) existingByCategory[r.category] = r.c;

  const totalExisting = existingRows.length;
  console.log("=== Amazon Search Results Scraper (Additive Mode) ===\n");
  console.log(`Existing products in DB: ${totalExisting}`);
  for (const [cat, count] of Object.entries(existingByCategory)) {
    console.log(`  ${cat}: ${count}`);
  }
  const categoryCount = Object.keys(CATEGORY_SEARCHES).length;
  console.log(`Target: ${TARGET_PER_CATEGORY} per category (${TARGET_PER_CATEGORY * categoryCount} total)\n`);

  const seenAsins = new Set(existingAsins);

  for (const [category, queries] of Object.entries(CATEGORY_SEARCHES)) {
    const existing = existingByCategory[category] || 0;
    const needed = TARGET_PER_CATEGORY - existing;

    if (needed <= 0) {
      console.log(`[${category}] Already at ${existing} — skipping`);
      continue;
    }

    console.log(`\n[${category}] Have ${existing}, need ${needed} more`);
    const categoryProducts: ScrapedProduct[] = [];

    for (const query of queries) {
      if (categoryProducts.length >= needed) break;

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

        const products = parseSearchResults(html, category);

        let added = 0;
        for (const p of products) {
          if (categoryProducts.length >= needed) break;
          if (!seenAsins.has(p.asin)) {
            seenAsins.add(p.asin);
            categoryProducts.push(p);
            added++;
          }
        }

        console.log(`${products.length} found, +${added} new (${existing + categoryProducts.length}/${TARGET_PER_CATEGORY})`);
      } catch (err: any) {
        console.log(`ERROR: ${err.message?.slice(0, 60)}`);
      }

      // 8-15s random delay
      await sleep(8000 + Math.random() * 7000);
    }

    console.log(`  [${category}] Added ${categoryProducts.length} new products`);
    newProducts.push(...categoryProducts);
  }

  console.log(`\n=== Scraping Complete ===`);
  console.log(`New products scraped: ${newProducts.length}`);

  if (newProducts.length === 0) {
    console.log("No new products to add.");
    process.exit(0);
  }

  // Verify images
  console.log("\nVerifying images...");
  let validCount = 0;
  const verifiedProducts: ScrapedProduct[] = [];
  for (const p of newProducts) {
    try {
      const res = await fetch(p.image_url, { method: "HEAD" });
      const len = parseInt(res.headers.get("content-length") || "0");
      if (res.ok && len > 500) {
        validCount++;
        verifiedProducts.push(p);
      }
    } catch {
      // skip products with broken images
    }
  }
  console.log(`Verified images: ${validCount}/${newProducts.length} (dropped ${newProducts.length - validCount})`);

  // Insert new products (additive — no clearing!)
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
  const finalCounts = db.prepare("SELECT category, COUNT(*) as c FROM products GROUP BY category").all() as { category: string; c: number }[];
  const totalFinal = (db.prepare("SELECT COUNT(*) as c FROM products").get() as { c: number }).c;
  console.log(`\nDatabase now has ${totalFinal} total products:`);
  for (const r of finalCounts) {
    console.log(`  ${r.category}: ${r.c}`);
  }

  console.log("\nDone!");
}

main().catch(console.error);
