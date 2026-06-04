import { execSync } from "child_process";
import db from "../src/db";

const CATEGORY = "Clothing & Fashion";

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

const ASIN_LIST: string[] = [
  // Dresses
  "B0DNF6MLKM", // PrettyGarden Pleated Midi Dress
  "B0DKXMRNCR", // PrettyGarden Eyelet Cover Up Maxi Dress
  "B0DJ32LHHL", // Anrabess A-Line Maxi Dress
  "B0D46BXDBK", // Yexpine Mini Shirtdress
  "B07RJX41HT", // ZESICA Bohemian Floral Wrap V-Neck Maxi Dress
  "B08M6GMKMP", // Wenrine Sleeveless Ribbed Bodycon Tank Mini Dress
  "B08VDSPJQ4", // TINYHI Summer Short-Sleeve Tunic T-Shirt Dress
  "B07CZ939NW", // Levaca Summer Short Sleeve Ruffle Swing Casual T-Shirt Dress
  "B0B5WTSSQ9", // VIUTIL Sexy Bodycon Sleeveless Maxi Dress
  "B0C8CKZ9F4", // GLNEGE Floral Midi Corset Dress
  "B0BJK535NB", // PUMIEY Square Neck Long Sleeve Ribbed Bodycon Maxi Dress
  "B07FNPLMHQ", // ECOWISH Polka Dot Summer Midi A-Line Ruffle Dress
  "B07FWSX5BX", // PrettyGarden Bodycon Tie Waist Pencil Dress

  // Jackets & Outerwear
  "B08JGCKG3T", // Tanming Flannel Shacket
  "B00HHOXQP8", // Orolay Down Jacket
  "B0FLQ9HH1K", // Maohao Cropped Trench Coat
  "B0D8T4MPSR", // Sidefeel Boyfriend Denim Jacket
  "B076V9XG3L", // CHARTOU Faux Suede Moto Biker Jacket
  "B0727PFRFN", // Levi's Original Trucker Denim Jacket
  "B078MR9NFR", // Levi's Women's Original Trucker Jacket
  "B012OV0QTW", // Wrangler Authentics Stretch Denim Jacket
  "B08QCC55G5", // LONGBIDA Frayed Cropped Denim Jacket
  "B0DJ2X4P2J", // Classic Wool Coat
  "B0DPW2546M", // PrettyGarden Blazer

  // Jeans & Pants
  "B096L351MJ", // Levi's Ribcage Straight Ankle Jeans
  "B0CBW7ZXFF", // Lee Ultra Lux Comfort Bootcut Jeans
  "B07TXGP44Q", // Tronjori High Waist Wide Leg Palazzo Pants
  "B0CNGMKFYR", // Tronjori Wide-Leg Palazzo Pants
  "B07CLH6YRM", // Cemi Ceri High Waist Dress Pants
  "B07J66TLKN", // GRACE KARIN High Waist Pencil Paper Bag Pants
  "B0DBHVPKYR", // COPYLEAF Wide Leg High Waist Yoga Pants
  "B08B5BFYP8", // Dokotoo Casual Loose Jogging Pants

  // Sneakers & Shoes
  "B093R9PKVC", // New Balance 574 Core Sneaker
  "B0G3ZH3NLB", // Project Cloud Mary Jane Sneakers
  "B0DJKMT6F6", // Sam Edelman Leather Michaela Mary Jane Flats
  "B09QWFY6PM", // Frank Mully Pointed-Toe Mesh Flats
  "B0CQ7286FT", // Project Cloud Leather Sandals
  "B0DSCP1L46", // CUSHIONAIRE Belinda Lace Detail Casual Sneakers
  "B08Z7HPL34", // Cushionaire Hana Cork Clog
  "B0CB5YJ8Z4", // DREAM PAIRS Platform Chunky Loafers
  "B09CH4X39W", // MIRAAZZURRA Sling Back Pumps Chunky Heels
  "B09TPG3VTV", // Bronax Cloud Slippers

  // Boots
  "B0C9Z7RTJF", // MeiLuSi Suede Knee-High Boots
  "B0DJSDH81N", // Adolilove Mid Calf Chunky Block Heel Boots
  "B0986SC1T6", // Vepose Women's Ankle Combat Lace Up Boots
  "B0B6PH8TG3", // SHIBEVER Women Winter Snow Boots

  // Handbags & Bags
  "B0FSQFHDH1", // JW Pei Yara Shoulder Bag
  "B0B7GDVBL7", // Queenoris Woven Tote Bag
  "B0CP6111V5", // BOSTANTEN Shoulder Hobo Handbag
  "B09GW2JBC2", // The Drop Addison Soft Volume Top Handle Bag
  "B0CT39T7NB", // GSYPS Acrylic Evening Clutch Shell Shape Bag
  "B091JSQZKJ", // GM LIKKIE Shoulder Tote Bag Nylon
  "B09KFH8CSR", // Claasico Crossbody Phone Purse RFID Wallet
  "B09ZXF9Z9T", // Ododos Mini Belt Bag
  "B08JBRDFKY", // Lubardy Laptop Bag Leather Tote

  // Sunglasses
  "B0DFYJCDGC", // GUVIVI Retro Oval Sunglasses Chic Cat Eye 90s
  "B0DYTXL6NF", // SOJOS Retro Oval Sunglasses UV400 Protection
  "B01DWD04PW", // SOJOS Small Round Polarized Vintage Retro Sunglasses
  "B07HYVV7T7", // Freckles Mark Vintage Retro 70s Large Squared Sunglasses
  "B0BP22M41B", // WOWSUN Polarized Sunglasses Womens Trendy
  "B0F8HWPP54", // ViewJoy Oval Sunglasses Set of 2

  // Jewelry
  "B07MRK5GBX", // Pavoi 14K Gold Chunky Hoops
  "B07TBN9JRJ", // PAVOI 14K Gold Plated Tennis Bracelet
  "B0CNV1QWHZ", // PAVOI 14K Gold Plated Stackable Rings Set
  "B0BZZJRW6P", // Freekiss Layered Gold Necklace 14K Gold Filled
  "B0B56FHPCX", // Freekiss Gold Herringbone Layered Chain Necklace
  "B07WXR221Q", // MEVECCO Gold Dainty Layer Lock Necklace 18K
  "B08L3XGNLR", // Yoosteel Gold Initial Necklaces 14K Gold Plated
  "B016RIJA6I", // Trendsmax Initial Pendant Necklace
  "B081RP2YWT", // Obidos Cuff Earrings 14K Gold Plated Ear Cuffs
  "B08D3CTZ54", // Badu Gold Plated Bead Ball Stretch Bracelet
  "B07S2ZGSVN", // Miabella 925 Sterling Silver Italian Herringbone Chain
  "B096TMMHMV", // VNOX Vintage Fashion Stainless Steel Gold Plated Ring

  // Activewear & Athleisure
  "B07YCZJS76", // Seasum Lifting Textured Yoga Pants
  "B0BMTBPS5J", // CRZ Yoga Butterluxe Workout Leggings
  "B0BK16JCR5", // CRZ YOGA Butterluxe Matte Faux Leather Leggings
  "B07HQM6NH8", // The Gym People Pocket Leggings
  "B0BB74WRCC", // Sunzel Flare Leggings Crossover Yoga Pants
  "B0BV9TFR1S", // Colorfulkoala Dreamlux High Waisted Workout Leggings
  "B07WYCL3D8", // Baleaf Fleece Lined Winter Leggings
  "B09B72NSW6", // Promover Bootcut Yoga Pants
  "B088M5Z6ZR", // THE GYM PEOPLE Longline Sports Bra
  "B0CTS7GMLJ", // PINSPARK Tennis Skirt Tummy Control Golf Skort
  "B07ZP5S3D6", // THE GYM PEOPLE Joggers Pants with Pockets

  // Sweaters & Knitwear
  "B07W7CNMTF", // Zesica Striped Sweater
  "B0CDBZHMDL", // Lillusory Striped Cardigan Sweater
  "B0C6Y3CKWM", // Lillusory Cocoon Cardigan
  "B0DJX9JQY3", // Imily Bela Cable Polo Sweater
  "B07VKJRW1K", // KIRUNDO Fuzzy Popcorn V-Neck Pullover Sweater
  "B0DJW7N9NZ", // Yousify Tie-Front Sweater Vest
  "B08KS42HJR", // WFHFNJW Houndstooth Pattern Knit Sweater Vest
  "B079R8JQBD", // Amazon Essentials Classic-Fit V-Neck Sweater
  "B07QF6B1PB", // Amazon Essentials Lightweight Crewneck Cardigan
  "B0FC2T3PDT", // GRECERELLE Lightweight Long Sleeve Cardigan Sweater

  // Watches
  "B0053HBJBE", // Casio F108WH Illuminator Digital Watch
  "B014CWHNQU", // Top Plaza Fashion Women's Analog Watch Rose Gold Tone
  "B01BNO36PW", // Tenworld Woman Lady Analog Quartz Wrist Watch

  // Scarves
  "B00PGQ3AI2", // Dimore Trendy Plaid Blanket Scarf Oversized Shawl
  "B016MDIO7Y", // NEOSAN Thick Ribbed Knit Winter Infinity Loop Scarf
  "B01MU1XZ3G", // Wander Agio Warm Long Shawl Winter Scarf
  "B019DE22WC", // Bess Bridal Plaid Blanket Winter Scarf Tartan Wrap
  "B07Y83L7B3", // FONYVE Silk Feeling Satin Head Scarf Square
  "B074PYFC5G", // WAYPOINT GOODS Infinity Scarf with Hidden Pocket

  // Hats
  "B01MS4FMYR", // KBETHOS Vintage Washed Cotton Baseball Cap
  "B099PTMWJR", // YANIBEST Satin Lined Beanie
  "B002G9UDYG", // Carhartt Knit Cuffed Beanie Hat
  "B07WRM2XXP", // Brook + Bay Ear Muffs Winter Women

  // Belts
  "B0D7Q4W31Z", // XZQTIVE Western Belt Concho Discs Cowgirl Waist Belt
  "B09TZ3VSXV", // Wolksprong Womens Belts for Jeans Full Grain Leather
  "B0D9ZMVS85", // Earnda Soft Faux Leather Fashion Belt

  // Tops & Other
  "B0B5H3TR5C", // Trendy Queen Half-Zip Hoodie
  "B0CWP9ZW3F", // Sampeel Mockneck Lounge Set
  "B0CDB9988R", // Zesica Ribbed Tank Top
  "B0CXJJHY8B", // Trendy Queen Going Out Tank Top
  "B0FKBBMXWD", // Vrtige Satin Lace-Trim Mini Skirt
  "B0CN4K7L1J", // BTFBM Satin Slip Skirt
  "B0CQ58VK2R", // Belle Poque Denim Skirt with Belt
  "B07L43BZTC", // PrettyGarden Off Shoulder Jumpsuit Romper
  "B07YLTD67R", // Amazon Essentials Studio Terry Jumpsuit
  "B071Z7ZL6R", // Kitsch Metal Hair Clips Gold Claw Clips
];

const FASHION_SEARCHES = [
  "trendy women clothing fashion 2025",
  "men fashion streetwear casual",
  "designer inspired handbag purse",
  "trendy sneakers casual shoes",
  "gold jewelry necklace bracelet set",
  "winter coat women fashion",
  "summer dress floral women",
  "athletic wear gym leggings",
  "vintage style retro fashion",
  "fashion accessories belt watch scarf",
];

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
      if (imgMatch) imageUrl = imgMatch[1];
    }
  }
  if (!imageUrl) return null;

  imageUrl = imageUrl
    .replace(/_AC_UY\d+_/, "_AC_SL1500_")
    .replace(/_AC_UL\d+_/, "_AC_SL1500_")
    .replace(/_SS\d+_/, "_AC_SL1500_")
    .replace(/_SX\d+_/, "_AC_SL1500_")
    .replace(/_SY\d+_/, "_AC_SL1500_");

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

  return { asin, title, image_url: imageUrl, price_cents: priceCents, category: CATEGORY };
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
    if (!priceDollars || priceDollars <= 0 || priceDollars >= 500) continue;
    const priceCents = Math.round(priceDollars * 100);

    products.push({ asin, title, image_url: imageUrl, price_cents: priceCents, category: CATEGORY });
  }

  return products;
}

async function main() {
  console.log(`=== Clothing & Fashion Product Scraper ===\n`);

  const existingAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) existingAsins.add(r.asin);
  console.log(`Existing products in DB: ${existingRows.length}`);

  const currentCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }).c;
  console.log(`Current "${CATEGORY}" count: ${currentCount}`);

  const allProducts: ScrapedProduct[] = [];
  const seenAsins = new Set(existingAsins);
  let captchaCount = 0;

  console.log(`\n--- Phase 1: Scraping ${ASIN_LIST.length} curated ASINs ---`);
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

    await sleep(5000 + Math.random() * 5000);
  }

  console.log(`\nPhase 1 complete: ${scraped} scraped, ${failed} failed`);

  // Phase 2: Search for more fashion products
  console.log(`\n--- Phase 2: Searching for more fashion products ---`);
  const targetNew = 100;
  for (const query of FASHION_SEARCHES) {
    if (allProducts.length >= targetNew) break;

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
        if (allProducts.length >= targetNew) break;
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
  console.log(`Total new products collected: ${allProducts.length}`);

  if (allProducts.length === 0) {
    console.log("No new products to add.");
    process.exit(0);
  }

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
  console.log(`Verified images: ${verifiedProducts.length}/${allProducts.length}`);

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

  const finalCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }).c;
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;
  console.log(`\n"${CATEGORY}" category now has ${finalCount} active products (+${finalCount - currentCount} new)`);
  console.log(`Database total active products: ${totalCount}`);
  console.log("\nDone!");
}

main().catch(console.error);
