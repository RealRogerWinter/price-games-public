import { execSync } from "child_process";
import db from "../src/db";

/**
 * Scrapes specific Amazon products by ASIN for the "Weird and Wonderful" category.
 *
 * v2 — Complete overhaul with 130+ diverse, curated ASINs sourced from:
 *   - Reader's Digest "Weirdest Things on Amazon"
 *   - BuzzFeed "70 Funny Gag Gifts"
 *   - Fox News "26 Weirdest Things You Can Buy on Amazon"
 *   - Yahoo Shopping "45+ Weird and Wonderful Things"
 *   - NextLuxury "29 Funny, Insane, and Weird Products"
 *   - Taste of Home "13 Crazy Food Items"
 *   - BuzzFeed "37 Strange But Delightful Products"
 *   - Society19 "30 Weird Gifts"
 *
 * Phase 0: Cleans up duplicate/low-quality items from previous scrapes
 * Phase 1: Scrapes curated ASINs (130+ unique, diverse products)
 * Phase 2: Falls back to targeted searches if needed
 *
 * ALL DATA IS SCRAPED FROM REAL AMAZON HTML. NOTHING IS FABRICATED.
 */

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

const CATEGORY = "Weird and Wonderful";

// ============================================================
// CURATED ASIN LIST — 130+ diverse, genuinely quirky products
// Each item is unique and interesting for a price-guessing game.
// Every ASIN verified from real listicle/blog sources.
// ============================================================
const ASIN_LIST: string[] = [
  // ── Novelty & Gag Gifts ────────────────────────────────────
  "B0010VS078", // Archie McPhee Yodeling Pickle (the OG classic)
  "B07CT6DYFG", // Toilet Timer — sand timer for bathroom visits
  "B09SBKLLTG", // Gift of Nothing — literally nothing in a box
  "B0DQNK98M7", // Mini Inflatable Tube Guy (Wacky Waving desktop)
  "B07B6T8B4S", // Bacon-Shaped Adhesive Bandages
  "B08BC25ZTP", // Butt Station — tape dispenser shaped like a butt
  "B0BXX8TTQT", // Flying Chicken Slingshot rubber launcher
  "B0C88QHZ48", // Tiny Finger Hands for your fingers
  "B07VYYDDBV", // Eyeball Sleep Mask — eyes-open illusion
  "B004A2LW6A", // Instant Underpants — just add water
  "0762459816", // Screaming Goat figurine + book set
  "0762462876", // Wacky Waving Inflatable Tube Man mini kit
  "B072L38SGT", // Witty Yeti Dehydrated Water — empty can gag
  "B000G82KI6", // Talking Toilet Paper Spindle — says phrases
  "B07D19KSSR", // Headlight Fluid — empty bottle car prank
  "B073C95WTN", // Chia Pet Bob Ross — grow Bob's afro
  "B003DM3MN4", // Emergency Underpants in a tin
  "B071XMM9VX", // World's Smallest Violin — tiny playable violin
  "B07H75BJWW", // Spider Prank Box — spider pops out
  "B08C4WMG9X", // Fake Potato Chip Can — spring snake prank
  "B01NAUCQIR", // Voice Activated Stickers — prank labels
  "B06XR4SD1V", // Fake Outlet Stickers — 10-pack wall prank
  "B075X12G58", // Fake Belly Dad Bag — hairy beer gut fanny pack
  "B07NPF4M2G", // Cheesy Dad Joke Cards — 101 groaners
  "B01MAUIT05", // Reindeer Farts Cotton Candy
  "B000VK4P14", // Ass Kickin' Carolina Reaper Jellybeans
  "B07QTFV38H", // "You've Been Poisoned" coffee mug
  "B007WFSGMU", // Dammit Doll — stress relief ragdoll
  "B07BZVLPVB", // Pop It Pal — pimple popping simulator toy
  "B07355WF8D", // Face Money Eating Bank — coin-eating face
  "B09L9XQQKR", // Porta Potty Shot Glasses — toilet shots
  "B07YHMH4PR", // Tiny Hands Finger Puppets — small hand set
  "B07CG2VJCH", // Shart Survival Kit wipes

  // ── Quirky Kitchen & Home ──────────────────────────────────
  "B07MB1SH1G", // Snail Soap Dispenser — press shell, soap trails out
  "B01G1G5SJO", // Angry Mama Microwave Cleaner — steam cleaning mom
  "B076CTTZKX", // OTOTO Gracula Garlic Crusher — Dracula-shaped press
  "B00B5EE0A6", // Manatea Tea Infuser — manatee in a hot tub
  "B08PQNS73H", // Toast-Shaped Night Light — bread LED lamp
  "B00QYCBK48", // Genuine Fred Ravioli Spoon Rest
  "B07VLBVQBP", // Red the Crab Silicone Utensil Rest
  "B07C66W1MK", // Jungle Spoon Monstera Leaf Ladle
  "B08VN8VTQQ", // Genuine Fred Desk Dumpster Pencil Holder
  "B0957ZYBLF", // Peleg Design Dustache Mustache Dustpan Set
  "B07S3DFQ5W", // Cherry-Shaped Toilet Brush
  "B016C1ULHM", // Cloud Magnetic Key Holder — keys float on cloud
  "B019ZS0W9Q", // Bicycle Pizza Cutter — rides across your pizza
  "B08KTQ67KX", // Genuine Fred Pickled Wine Stopper
  "B07MV4LP6S", // Camera Lens Coffee Mug — DSLR lens replica
  "B0047E0EII", // Hutzler Banana Slicer — legendary Amazon reviews
  "B00RUSNLX8", // Silicone Snail Tea Bag Holders (10-pack)
  "B071CM5JF6", // PB-Jife — The Ultimate Peanut Butter Knife
  "B001XSFW42", // Pizza Boss 3000 — circular saw pizza cutter
  "B0016CVUR8", // Hamburger Cheeseburger Telephone — retro phone
  "B01N5GT63I", // Florino Friendly Flower Vase — smiling face vase
  "B0851WWXHC", // Cat-Shaped Silicone Ice Cube Tray
  "B08R8YVH9G", // Vinyl Record Coasters Set of 6

  // ── Weird Fashion & Accessories ────────────────────────────
  "B07Y72N47M", // Butter Toast Crossbody Shoulder Bag
  "B0C8TMB5WZ", // Magnetic Hand-Holding Socks — couple socks
  "B086TY4VVQ", // Fish Flip-Flops — realistic fish sandals
  "B01MRUJPGX", // Pizza Socks in a Pizza Box (4 pairs)
  "B00BC1GCOO", // Bobcat Mullet Headband — instant mullet
  "B0CH9TWC91", // Wearable Shark Blanket Hoodie
  "B00B4S6SLW", // Ostrich Pillow — immersive nap headgear
  "B00KAH704W", // Lazy Reader Prism Glasses — read lying down
  "B0CKSXKX4F", // Snail Spa Headband — cute snail on your head
  "B0BJKM4864", // Fluffy Corgi Butt Slippers
  "B0BHY3K6ZL", // Chicken Leg Socks — realistic drumstick legs
  "B0C1H4N314", // Hot Dog Finger Oven Mitts
  "B07V8RG45Z", // Tiny IKEA Bag Coin Purse / Keychain
  "B07YW9JD1W", // Bread Loaf Slippers — soft baguette shoes
  "B00V30PFLK", // Umbrella Hat — hands-free rain/sun hat

  // ── Funny Plush, Pillows & Blankets ────────────────────────
  "B0CY1YXK7V", // Giant White Goose Plush (body pillow size)
  "B07QX3YJLH", // Burrito Tortilla Blanket — wrap like a burrito
  "B07SHP29DM", // 3D Baguette Bread Body Pillow (40 inches)
  "B0CTKZ8PRC", // Emotional Support Crinkle Fries plush
  "B06XXQD54H", // Accoutrements Handisquirrel — finger squirrel
  "B07P2YD1T5", // 200 Tiny Plastic Babies — mini baby figurines
  "B082413MWQ", // Chubby Blob Seal Pillow (small)
  "B07ZMCDNCD", // Chubby Blob Seal Pillow (large, 24 inch)
  "B01ABKKCTW", // Shrimp Neck Pillow — prawn-shaped travel pillow
  "B09T5WMHD4", // Emotional Support Fries Plushies set
  "B0C484MLCG", // Dino Nugget Pillow set (3 piece)
  "B007S9RVCQ", // Boyfriend Pillow — arm-around-you pillow
  "B0BGBMZMMQ", // Lying Flat Duck Night Light — LED desk duck
  "B07RPZZ867", // Taco Sleeping Bag Blanket

  // ── Games & Weird Fun ──────────────────────────────────────
  "B07TS96J7Q", // Throw Throw Burrito — card game meets dodgeball
  "B09R3QNLR9", // Zombie Kittens Card Game by Exploding Kittens
  "B000LC65QA", // Potty Putter — toilet golf putting game
  "B0F4K3JK3T", // Mini Punching Bag for Desk with finger gloves
  "B076C5YVCK", // Shocktato Game — hot potato with real shocks
  "B077Z1R28P", // Taco Cat Goat Cheese Pizza card game
  "B07M9W1WM1", // Mobile Phone Jail — lock up your devices
  "B08Y7BQM7G", // Star Wars Pooper Pack (Vader toilet paper holder)

  // ── Quirky Decor & Collectibles ────────────────────────────
  "B07G7FN1CV", // Dachshund Riding Garden Gnome sculpture
  "B0F5Q3W4GK", // Cat-Butt Tissue Holder (the original funny one)
  "B0754Y9GNH", // Pooping Pooches Calendar (dogs pooping, monthly)
  "B0D73J426H", // Social Battery Enamel Pin / Desk Sign
  "B001G8N95I", // Rubber Chicken Purse — zippered handbag
  "B07CD7S9PZ", // Sharper Image LED Word Clock — text tells time
  "B09VGSMBQN", // Spine Candle — vertebrae-shaped candle
  "B07KF5GQJZ", // Giraffe Eyeglass Holder Stand
  "B014LIOC64", // Squirrel Feeder Unicorn Head (outdoor mount)
  "B00HZJ0JW8", // Arthur Egg Cup Holder — legs dangle off table
  "B0DCGQG7P9", // Puffin Puffer Jacket Cup Cooler (drink jacket)
  "B01HH4OJMG", // Custom Face Stickers — your face on stickers

  // ── Tech & Gadgets ─────────────────────────────────────────
  "B0761VVFDX", // Bluetooth Banana Phone — actual phone handset
  "B077YJLNDJ", // LED Flashlight Gloves — lights on fingertips
  "B06Y26VYP8", // Star Wars Lightsaber Chopsticks (LED, light up)

  // ── Weird Food, Drinks & Candles ───────────────────────────
  "B0CQ2746WY", // Dr. Pepper Scented Candle
  "B0D97SYQP6", // "Light Me When the Dog Farts" Candle
  "B00WXZJTS4", // Dehydrated Cereal Marshmallows (just the mallows)
  "B0089KZPNU", // Canned Unicorn Meat (plush unicorn in a can)
  "B010R54C5Q", // Jelly Belly Draft Beer Flavored Jelly Beans
  "B01ETRG0PS", // Lester's Fixins Pumpkin Pie Soda
  "B00PYM8VLE", // Best Maid Dill Pickle Juice (full gallon jug)
  "B07X3DSDK2", // Pickle Flavored Mints

  // ── Useful-but-Weird ───────────────────────────────────────
  "B09J746BHB", // Meat Shredder Wolverine Claws
  "B07D1KW3PB", // Saucemoto Dip Clip — car vent sauce holder
  "B09PC6F6D7", // Hot Dog Shaped Adhesive Bandages
  "B00BPWU3SQ", // Shakespearean Insult Bandages
  "B07Z5FKTQW", // Dr. Sheffield's Chocolate Toothpaste (2-pack)
  "B07NF96R47", // CVS Receipt Scarf — impossibly long knit scarf
  "B00CFM8DI2", // Boot Bananas — banana-shaped shoe deodorizers
  "B07HDX46HS", // Crayola Globbles — sticky throw-and-stick balls (6ct)
  "0762464127", // Zen Garden Litter Box mini book kit

  // ── Desk Toys & Office Fun ─────────────────────────────────
  "B0DNDP6N98", // Poseable Stick Figure Night Light
  "B09YTM2MX2", // Bazooka Bubble Gun Machine — gatling bubbles
  "B0BQZFVJTB", // NeeDoh Nice Cube — squishable stress cube
  "B01CA2HOZ4", // ChopSabers Lightsaber Chopsticks (non-LED set)
  "B09D3L5KTS", // Funny Cat Middle Finger Hand Towels
];

// ── Duplicate ASINs to deactivate ────────────────────────────
// These are low-quality items from previous search-based scraping
// that flooded the category with repetitive products.
const DUPLICATE_TITLE_PATTERNS = [
  // Too many yodeling pickle variants (keep only B0010VS078)
  /yodel.*pickle/i,
  /pickle.*yodel/i,
  /singing.*pickle/i,
  /pickle.*sing/i,
  /dancing.*pickle/i,
  /pickle.*danc/i,
  /farting.*pickle/i,
  /pickle.*fart/i,
  /screaming.*pickle/i,
  /pickle.*scream/i,
  /emotional.*support.*pickle/i,
  /pickle.*plush/i,
  /pickle.*stuff/i,
  /pickle.*toy/i,
  /pickle.*squeaky/i,
  /pickle.*cucumber/i,
  /pickle.*microphone/i,
  /pickle.*cat/i,
  /rubber.*pickle/i,
  // Nicolas Cage / Danny DeVito merchandise (not weird enough for price game)
  /nicolas.*cage/i,
  /nic.*c[aä]ge/i,
  /danny.*devito/i,
  /cage.*sequin/i,
  // Too many generic cat tissue holders (not quirky, just cat-themed)
  /cat.*tissue.*box/i,
  /cat.*tissue.*holder/i,
  /cat.*tissue.*cover/i,
  /cat.*tissue.*dispenser/i,
  /cat.*paper.*towel/i,
  /cat.*toilet.*roll/i,
  /cat.*toilet.*paper/i,
  /black.*cat.*tissue/i,
  /kitten.*tissue/i,
  /cat.*napkin/i,
  /cat.*facial.*paper/i,
  // Too many generic clown noses (boring for game)
  /clown.*nose/i,
  /circus.*nose/i,
  /foam.*nose.*clown/i,
  /red.*nose.*clown/i,
  /sponge.*nose/i,
];

// ASINs to keep even if they match a pattern above (our curated picks)
const KEEP_ASINS = new Set([
  "B0010VS078", // The original Yodeling Pickle (the classic)
  "B0F5Q3W4GK", // Cat-Butt Tissue Holder (genuinely funny)
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchProductPage(asin: string): string {
  const url = `https://www.amazon.com/dp/${asin}`;
  return execSync(
    [
      "curl -s -L --max-time 20",
      '-H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"',
      '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"',
      '-H "Accept-Language: en-US,en;q=0.9"',
      '-H "Accept-Encoding: identity"',
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
  const hiResMatch = html.match(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
  if (hiResMatch) {
    imageUrl = hiResMatch[1];
  } else {
    const landingMatch = html.match(/id="landingImage"[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (landingMatch) {
      imageUrl = landingMatch[1];
    } else {
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

// Search queries — highly targeted to find DIVERSE weird items
// (avoids generic queries that return pages of the same product type)
const WEIRD_SEARCHES = [
  "funny gag gift unique novelty toy",
  "weird kitchen gadget quirky utensil",
  "funny office desk toy stress relief",
  "novelty food shaped pillow plush",
  "unusual wearable funny costume accessory",
  "quirky home decor funny sculpture",
  "weird tech gadget bluetooth novelty",
  "funny bathroom gift toilet humor",
  "strange candy food drink novelty",
  "prank gift box fake product",
];

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

    // Skip search results that match our duplicate patterns
    if (DUPLICATE_TITLE_PATTERNS.some((p) => p.test(title))) continue;

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
  console.log(`=== Weird & Wonderful Product Scraper v2 ===`);
  console.log(`Category: "${CATEGORY}"`);
  console.log(`Curated ASINs: ${ASIN_LIST.length}\n`);

  // ────────────────────────────────────────────────────────────
  // Phase 0: Clean up duplicate/low-quality products
  // ────────────────────────────────────────────────────────────
  console.log(`--- Phase 0: Cleaning up duplicate/low-quality products ---`);

  const weirdProducts = db
    .prepare("SELECT id, asin, title FROM products WHERE category = ? AND is_active = 1")
    .all(CATEGORY) as { id: number; asin: string; title: string }[];

  let deactivated = 0;
  const deactivateStmt = db.prepare("UPDATE products SET is_active = 0 WHERE id = ?");

  for (const p of weirdProducts) {
    if (KEEP_ASINS.has(p.asin)) continue;
    const shouldDeactivate = DUPLICATE_TITLE_PATTERNS.some((pattern) => pattern.test(p.title));
    if (shouldDeactivate) {
      deactivateStmt.run(p.id);
      deactivated++;
      console.log(`  DEACTIVATED: ${p.title.substring(0, 70)}`);
    }
  }

  const remainingCount = (
    db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }
  ).c;
  console.log(`\nDeactivated ${deactivated} duplicate/low-quality products`);
  console.log(`Remaining active in "${CATEGORY}": ${remainingCount}\n`);

  // ────────────────────────────────────────────────────────────
  // Phase 1: Scrape curated ASINs
  // ────────────────────────────────────────────────────────────
  const existingAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) existingAsins.add(r.asin);
  console.log(`Total existing products in DB: ${existingRows.length}`);

  // Deduplicate the ASIN list itself
  const uniqueAsins = [...new Set(ASIN_LIST)];
  const newAsins = uniqueAsins.filter((a) => !existingAsins.has(a));
  console.log(`Curated ASINs to scrape: ${newAsins.length} (${uniqueAsins.length - newAsins.length} already in DB)\n`);

  const allProducts: ScrapedProduct[] = [];
  const seenAsins = new Set(existingAsins);
  let captchaCount = 0;

  console.log(`--- Phase 1: Scraping ${newAsins.length} curated ASINs ---`);
  let scraped = 0;
  let failed = 0;

  for (const asin of newAsins) {
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

  // ────────────────────────────────────────────────────────────
  // Phase 2: Search for more weird products (only if needed)
  // ────────────────────────────────────────────────────────────
  const targetTotal = Math.max(100 - remainingCount, 0);
  if (allProducts.length < targetTotal) {
    console.log(`\n--- Phase 2: Searching for more weird products (need ${targetTotal - allProducts.length} more) ---`);
    for (const query of WEIRD_SEARCHES) {
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
  } else {
    console.log(`\nPhase 2 skipped — have enough products from curated list.`);
  }

  console.log(`\n=== Scraping Complete ===`);
  console.log(`Total new products collected: ${allProducts.length}`);

  if (allProducts.length === 0) {
    console.log("No new products to add.");
    const finalCount = (
      db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }
    ).c;
    console.log(`"${CATEGORY}" has ${finalCount} active products.`);
    process.exit(0);
  }

  // ────────────────────────────────────────────────────────────
  // Verify images
  // ────────────────────────────────────────────────────────────
  console.log("\nVerifying images...");
  const verifiedProducts: ScrapedProduct[] = [];
  for (const p of allProducts) {
    try {
      const res = await fetch(p.image_url, { method: "HEAD" });
      const len = parseInt(res.headers.get("content-length") || "0");
      if (res.ok && len > 500) {
        verifiedProducts.push(p);
      } else {
        console.log(`  DROPPED (bad image): ${p.title.substring(0, 50)}`);
      }
    } catch {
      console.log(`  DROPPED (image fetch error): ${p.title.substring(0, 50)}`);
    }
  }
  console.log(`Verified images: ${verifiedProducts.length}/${allProducts.length}`);

  // ────────────────────────────────────────────────────────────
  // Insert into database
  // ────────────────────────────────────────────────────────────
  console.log("\nInserting new products...");
  const insert = db.prepare(
    `INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))`
  );

  const insertMany = db.transaction((items: ScrapedProduct[]) => {
    for (const p of items) {
      insert.run(p.asin, p.title, p.image_url, p.title, p.price_cents, p.category);
    }
  });

  insertMany(verifiedProducts);
  console.log(`Inserted ${verifiedProducts.length} new products.`);

  // ────────────────────────────────────────────────────────────
  // Final stats
  // ────────────────────────────────────────────────────────────
  const finalWeirdCount = (
    db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }
  ).c;
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  "${CATEGORY}" now has ${finalWeirdCount} active products`);
  console.log(`║  Database total active: ${totalCount}`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log("\nDone!");
}

main().catch(console.error);
