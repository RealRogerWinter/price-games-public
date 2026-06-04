import { execSync } from "child_process";
import db from "../src/db";

/**
 * Scrapes Amazon product pages one at a time to build the product database.
 * Uses curl with full browser headers to avoid bot detection.
 * Processes sequentially with random 6-12s delays between requests.
 */

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

// Real ASINs organized by category - verified from the original curated list
const ASIN_CATEGORIES: Record<string, string[]> = {
  Electronics: [
    "B0D1XD1ZV3", // AirPods 4
    "B0BDHWDR12", // AirPods Pro 2nd Gen
    "B09V3KXJPB", // iPad Air 5th Gen
    "B0CM5JV268", // MacBook Pro M3
    "B094C4VDJZ", // Sony WF-1000XM4
    "B09XS7JWHH", // Sony WH-1000XM5
    "B0C8S9LHPM", // Sony WH-1000XM5 (alt)
    "B07S395RWD", // Logitech MX Master 3
    "B085TFF7M1", // Logitech C270 Webcam
    "B09B8V1LZ3", // Fire TV Stick 4K
    "B07FZ8S74R", // Echo Dot 3rd Gen
    "B09B8W5FW7", // Echo Dot 5th Gen
    "B08N5WRWNW", // Kindle Paperwhite
    "B09SWRYPB2", // Kindle Paperwhite 11th
    "B09MVDBRJP", // PS5 DualSense
    "B08FC6MR62", // PS5 Controller
    "B0BCNKKZ91", // PS5 Pulse 3D
    "B08HRJKBMQ", // Elgato Stream Deck MK.2
    "B0763GKTJN", // Blue Yeti USB Mic
    "B07QH4LBHQ", // HyperX Cloud II
    "B0BG6YWSD8", // SteelSeries Arctis Nova 7
    "B0BDHB9Y8H", // SanDisk 1TB Extreme Pro
    "B084RMZ2DG", // Samsung EVO microSD 256GB
    "B09B1GXM16", // Samsung 980 PRO SSD
    "B0BT1LWFYG", // Sony InZone H9
    "B0988DQSGH", // JBL Flip 6
    "B09GYQYHKZ", // JBL Charge 5
    "B0839NF2ST", // Ring Video Doorbell
    "B0B6GKVS8H", // Blink Mini Indoor Camera
    "B08N5LM1K3", // TP-Link Kasa Smart Plug
  ],

  "Home & Kitchen": [
    "B00FLYWNYQ", // Instant Pot Duo
    "B075CYMYK6", // Instant Pot Duo Plus
    "B00005UP2K", // KitchenAid Classic Stand Mixer
    "B0936FGLQS", // COSORI Air Fryer
    "B07GJBBGHG", // Ninja AF101 Air Fryer
    "B089TQFQBZ", // Ninja DZ201 Foodi Air Fryer
    "B00008CM67", // Lodge Cast Iron Skillet 10.25"
    "B000LEXR0K", // Lodge Cast Iron Skillet 12"
    "B0758JHZM3", // Vitamix 5200
    "B01686OIKI", // NutriBullet Pro
    "B00KWLMYGO", // Magic Bullet Blender
    "B00005UPPI", // KitchenAid Artisan Stand Mixer
    "B0B1BN7N1G", // Keurig K-Supreme
    "B07C1XC3GF", // Keurig K-Mini
    "B083K2FQTL", // Mr. Coffee Iced Coffee Maker
    "B005P0AYSW", // Weber Original Kettle Grill
    "B007JJFTO4", // Aeropress Coffee Press
    "B01N7FC4YJ", // Lodge Enameled Dutch Oven
    "B08P56HCLZ", // Crock-Pot 7-Quart
    "B08JQ91B8G", // DASH Rapid Egg Cooker
    "B07TZ5YHJN", // Dash Mini Waffle Maker
    "B071CQXTFM", // Fullstar Vegetable Chopper
    "B0000CFQJS", // OXO Good Grips Kitchen Scale
    "B00004OCKR", // OXO Salad Spinner
    "B004W8LT6I", // Pyrex Glass Food Storage
    "B081SGGQFX", // Rubbermaid Brilliance
    "B015SY3VGI", // Brita Large Water Pitcher
    "B006QF3TW4", // BRITA Standard Filter 10-ct
    "B078PHPLW7", // Hydro Flask 32oz
    "B0CFCRS8V1", // Stanley Quencher H2.0 40oz
  ],

  "Beauty & Personal Care": [
    "B01F1LZ5V6", // CeraVe Moisturizing Cream 19oz
    "B00U1YCRD8", // CeraVe Hydrating Facial Cleanser
    "B079H99466", // CeraVe AM Moisturizer SPF 30
    "B0071GSMMC", // CeraVe PM Moisturizing Lotion
    "B00G7TOVE0", // CeraVe Foaming Facial Cleanser
    "B004D2826K", // Neutrogena Hydro Boost Water Gel
    "B01HOHBS7K", // Neutrogena Ultra Sheer SPF 70
    "B003G4BP5G", // Neutrogena Makeup Remover Wipes
    "B0776VD6W8", // Oral-B Pro 1000
    "B09LDKCCR8", // Oral-B iO Series 5
    "B071NQFH8R", // Waterpik Aquarius Water Flosser
    "B08HLCXCGN", // Crest 3D Whitestrips
    "B003YMJJSK", // Aveeno Daily Moisturizing Lotion
    "B00027DDOQ", // Cetaphil Gentle Cleanser
    "B0048ZUIY6", // Aquaphor Healing Ointment
    "B01BT02Q2K", // Paula's Choice 2% BHA
    "B002CML1VG", // Thayers Witch Hazel Toner
    "B08FXZXWBC", // REVLON One-Step Volumizer
    "B003WKM9MI", // Dyson Supersonic Hair Dryer
    "B001QFZXSY", // Dove Beauty Bar 14-pack
    "B07GKSV62K", // Gillette ProGlide 12-count
    "B0BGJ5BZHD", // Philips OneBlade
    "B083TPBT7L", // COSRX Snail Mucin Essence
    "B07RZRBB1P", // Mighty Patch Original
    "B0009F5YN0", // Sensodyne Pronamel
    "B07KRG2N9S", // EltaMD UV Clear SPF 46
    "B00TCD51DQ", // La Roche-Posay Toleriane
    "B001E96OMG", // Bioderma Sensibio H2O
    "B000Q94RTC", // Wahl Color Pro Clipper
    "B07XWGHXSM", // Remington PG6171 Trimmer
  ],

  "Sports & Outdoors": [
    "B074DZ45TN", // Amazon Basics Neoprene Dumbbells
    "B01LP0U60K", // BalanceFrom GoYoga Mat
    "B074DYBCFB", // Manduka PRO Yoga Mat
    "B07D3RCDMF", // Gaiam Essentials Yoga Mat
    "B09P4DPNPX", // Bowflex SelectTech 552
    "B08DG1BQWZ", // FLYBIRD Adjustable Bench
    "B0BGZ9HJDL", // Fit Simplify Resistance Bands
    "B073NVS7T8", // Te-Rich Resistance Bands
    "B083GBFTXS", // Hydro Flask 32oz
    "B0881ZHBH5", // YETI Rambler 26oz
    "B0C46T6BLR", // Owala FreeSip 24oz
    "B07QH3N2TC", // Iron Flask Water Bottle
    "B018HIFHFY", // Coleman Sundome 4-Person Tent
    "B01HMTO6QK", // LifeStraw Personal Water Filter
    "B074N6FZ5F", // TETON Sports Scout Sleeping Bag
    "B07K2P7YCJ", // Klymit Static V Sleeping Pad
    "B014MGEBHO", // Osprey Atmos AG 65
    "B019TBQ3IO", // The North Face Borealis
    "B0B5B63G7V", // Fitbit Charge 6
    "B0C7BDDGB6", // Garmin Forerunner 265
    "B074XBX1WG", // TRX All-in-One Suspension
    "B08FXWLKHP", // Theragun Elite
    "B074XIKNKD", // Trigger Point GRID Foam Roller
    "B003AI2502", // Speedo Vanquisher 2.0 Goggles
    "B0016BPS3E", // GoSports Cornhole Set
    "B001ARYU58", // SKLZ Quick Ladder
    "B09NNTKWPS", // Callaway Supersoft Golf Balls
    "B0B1SLTB64", // Titleist Pro V1 Golf Balls
    "B076TSLFV7", // Black Diamond Trekking Poles
    "B01A7YPYII", // Kryptonite U-Lock
  ],

  "Toys & Games": [
    "B00U26V4VQ", // Catan Board Game
    "B0BX49VV8Q", // Ticket to Ride
    "B07QQ2LKM7", // Codenames
    "B00NX627HW", // Pandemic Board Game
    "B084GSJKV2", // Monopoly Classic
    "B00005N5PF", // Risk Board Game
    "B07SG83QYF", // Wingspan Board Game
    "B00004TZY8", // Uno Card Game
    "B01ASCZUSG", // Exploding Kittens
    "B076QSB7FX", // Sushi Go Party!
    "B0006HCVT8", // Phase 10 Card Game
    "B09Q16L3ZM", // LEGO Botanical Orchid
    "B09Q17TQPD", // LEGO Creator Bonsai Tree
    "B0B8B44SY2", // LEGO Classic Creative Bricks
    "B07VHK8JPN", // Play-Doh Starter Set
    "B00MJ8JSFE", // Crayola 120 Crayons
    "B07VJRZ62R", // Nintendo Switch Pro Controller
    "B073X4RF8C", // Nintendo Switch Joy-Con
    "B07HMV82YG", // Ravensburger 1000-piece Puzzle
    "B08JQVF17T", // Jenga Classic
    "B00GJPKLDG", // Connect 4 Classic
    "B01BGMFSD0", // Simon Electronic Game
    "B01N3MLKTP", // Bananagrams
    "B078BWQHB3", // Spot It! Card Game
    "B00000IZJT", // Twister Game
    "B0995NKSQD", // Rubik's Cube Speed Cube
    "B07WJ1HSLC", // Holy Stone HS210 Mini Drone
    "B01M1OBO5D", // Magna-Tiles 100-piece
    "B07FKR6KXF", // ThinkFun Gravity Maze
    "B00NHQF6MG", // LEGO DUPLO All-in-One-Box
  ],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrapeProduct(asin: string, category: string): ScrapedProduct | null {
  const url = `https://www.amazon.com/dp/${asin}`;

  try {
    const html = execSync(
      [
        "curl -s -L --max-time 15",
        '-H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"',
        '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"',
        '-H "Accept-Language: en-US,en;q=0.9"',
        '-H "Accept-Encoding: identity"',
        '-H "Sec-Ch-Ua: \\"Chromium\\";v=\\"122\\""',
        '-H "Sec-Ch-Ua-Mobile: ?0"',
        '-H "Sec-Ch-Ua-Platform: \\"macOS\\""',
        '-H "Sec-Fetch-Dest: document"',
        '-H "Sec-Fetch-Mode: navigate"',
        '-H "Sec-Fetch-Site: none"',
        '-H "Sec-Fetch-User: ?1"',
        '-H "Upgrade-Insecure-Requests: 1"',
        '-b "session-id=000-0000000-0000000"',
        `"${url}"`,
      ].join(" "),
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    // Check for captcha
    if (html.includes("captcha") || html.includes("validateCaptcha")) {
      return { asin, title: "", image_url: "", price_cents: 0, category: "CAPTCHA" };
    }

    // Check for 404
    if (html.includes("Page Not Found") || html.includes("dogsofamazon")) {
      return null;
    }

    // Extract title
    const titleMatch = html.match(/id="productTitle"[^>]*>\s*([^<]+)/);
    const title = titleMatch ? titleMatch[1].trim() : null;
    if (!title) return null;

    // Extract price
    const priceMatch = html.match(/\$([0-9,]+\.[0-9]{2})/);
    const priceDollars = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;
    if (!priceDollars || priceDollars <= 0) return null;

    // Extract image
    let imageUrl: string | null = null;
    const hiRes = html.match(/"hiRes":"(https:\/\/[^"]+)"/);
    if (hiRes) imageUrl = hiRes[1];
    else {
      const large = html.match(/"large":"(https:\/\/[^"]+)"/);
      if (large) imageUrl = large[1];
    }
    if (!imageUrl) {
      const og = html.match(/property="og:image"\s+content="(https:\/\/[^"]+)"/);
      if (og) imageUrl = og[1];
    }
    if (!imageUrl) return null;

    return {
      asin,
      title,
      image_url: imageUrl,
      price_cents: Math.round(priceDollars * 100),
      category,
    };
  } catch {
    return null;
  }
}

async function main() {
  const allProducts: ScrapedProduct[] = [];
  let captchaStreak = 0;

  console.log("=== Amazon Product Scraper ===\n");

  for (const [category, asins] of Object.entries(ASIN_CATEGORIES)) {
    console.log(`\n[${category}] Scraping ${asins.length} products...`);

    for (let i = 0; i < asins.length; i++) {
      const asin = asins[i];
      process.stdout.write(`  [${i + 1}/${asins.length}] ${asin}... `);

      const product = scrapeProduct(asin, category);

      if (product && product.category === "CAPTCHA") {
        captchaStreak++;
        console.log("CAPTCHA");
        if (captchaStreak >= 3) {
          console.log("  Hit captcha wall. Waiting 90s...");
          await sleep(90000);
          captchaStreak = 0;
          i--; // retry
          continue;
        }
        await sleep(15000);
        continue;
      }

      captchaStreak = 0;

      if (product) {
        allProducts.push(product);
        console.log(`OK ${product.title.slice(0, 45)} ($${(product.price_cents / 100).toFixed(2)})`);
      } else {
        console.log("SKIP (404 or no data)");
      }

      // Random delay 6-12s
      await sleep(6000 + Math.random() * 6000);
    }
  }

  console.log(`\n=== Scraping Complete ===`);
  console.log(`Total products scraped: ${allProducts.length}`);

  // Now seed the database
  console.log("\nClearing existing data...");
  db.prepare("DELETE FROM game_rounds").run();
  db.prepare("DELETE FROM game_sessions").run();
  db.prepare("DELETE FROM products").run();

  console.log("Inserting products...");
  const insert = db.prepare(
    `INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );

  const insertMany = db.transaction((items: ScrapedProduct[]) => {
    for (const p of items) {
      insert.run(p.asin, p.title, p.image_url, p.title, p.price_cents, p.category);
    }
  });

  insertMany(allProducts);

  // Stats
  const countByCategory: Record<string, number> = {};
  for (const p of allProducts) {
    countByCategory[p.category] = (countByCategory[p.category] || 0) + 1;
  }
  console.log(`\nTotal products inserted: ${allProducts.length}`);
  for (const [cat, count] of Object.entries(countByCategory)) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log("\nDone!");
}

main().catch(console.error);
