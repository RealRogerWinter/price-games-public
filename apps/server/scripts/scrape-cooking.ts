import { execSync } from "child_process";
import db from "../src/db";

/**
 * Scrapes specific Amazon products by ASIN for the "Cooking Gadgets" category.
 * ASINs sourced from best-of lists, reviews, and Amazon best-seller pages
 * for cooking gadgets, kitchen tools, and innovative culinary accessories.
 *
 * Uses mobile user-agent to reduce CAPTCHA rate, with fallback to curated
 * product data (verified image IDs and prices) when live scraping is blocked.
 */

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

const CATEGORY = "Cooking Gadgets";

// Curated products with VERIFIED image IDs from live Amazon pages (mobile UA).
// All image IDs tested and confirmed accessible on m.media-amazon.com CDN.
const PRODUCT_DATA: Array<{
  asin: string;
  title: string;
  imageId: string;
  priceCents: number;
}> = [
  // Air Fryers & Multi-Cookers
  { asin: "B0C33CHG99", title: "Cosori 9-in-1 TurboBlaze Air Fryer 6 Qt, Premium Ceramic Coating, 90-450F, Precise Heating, Dark Gray", imageId: "41r43xn22lL", priceCents: 8988 },
  { asin: "B0CSZ7WBYW", title: "Ninja Air Fryer Pro 4-in-1, 5QT Capacity, Air Fry, Roast, Reheat, Dehydrate, 400F Max Temp, Grey, AF141", imageId: "41s2+VsF0YL", priceCents: 8999 },
  { asin: "B097TSGT9G", title: "Instant Pot 6Qt Duo 120V V5, 7-in-1 Electric Pressure Cooker, Slow Cooker, Rice Cooker, Steamer", imageId: "41vStNkjMOL", priceCents: 10999 },
  { asin: "B01NBKTPTS", title: "Instant Pot Duo Plus 9-in-1 Multicooker, Pressure Cooker, Slow Cook, Rice Maker, Steamer, 6 Quarts", imageId: "41iDWX1l1GL", priceCents: 13999 },
  { asin: "B07W55DDFB", title: "Instant Pot Duo Evo Plus 10-in-1 Pressure Cooker, Rice Cooker, Slow Cooker, Yogurt Maker, Sous Vide, 6 Qt", imageId: "41dDzAmWwaL", priceCents: 13999 },
  { asin: "B0936FGLQS", title: "COSORI Air Fryer Pro, Compact 5QT, Ceramic Coating, 7 Presets with Preheat, Shake Reminder", imageId: "41TKOcGeZzL", priceCents: 9999 },

  // Ice Cream Makers
  { asin: "B08QXB9BH5", title: "Ninja NC301 CREAMi Ice Cream Maker, for Gelato, Mix-ins, Milkshakes, Sorbet, 7 One-Touch Programs, Silver", imageId: "319FsWgMWuL", priceCents: 22999 },
  { asin: "B09QV24FFZ", title: "Ninja CREAMi Ice Cream Maker 7-in-1, Gelato, Sorbet, Milkshakes, Smoothie Bowls, One-Touch, Black", imageId: "31eNQ3PWNHL", priceCents: 21999 },

  // Sous Vide & Precision Cooking
  { asin: "B0BQ9F56WV", title: "Anova Culinary Sous Vide Precision Cooker 3.0 (WiFi), 1100 Watts, App Control, Black", imageId: "41B6Pr8rUVL", priceCents: 19900 },
  { asin: "B0CZ7KJGWQ", title: "Anova Culinary Sous Vide Precision Cooker Mini, 850 Watts, Black and Orange, App Enabled, 2024 Model", imageId: "41iahV5ev4L", priceCents: 5295 },
  { asin: "B07QFC6LN6", title: "Anova Culinary Sous Vide Precision Cooker Pro, 1200 Watts, Black and Silver", imageId: "41XFRVF7U4L", priceCents: 45900 },

  // Kitchen Thermometers
  { asin: "B0DG71Q1LZ", title: "ThermoWorks Thermapen ONE, No. 1 Recommended Instant-Read Thermometer, Cayenne Pepper Red", imageId: "21edhHykx8L", priceCents: 12500 },
  { asin: "B0DG6PWW3N", title: "ThermoWorks Classic Thermapen, Highly-Rated Instant-Read Thermometer, Cayenne Pepper Red", imageId: "41P6f4dNmFL", priceCents: 10500 },
  { asin: "B07XXSYLL8", title: "TempPro TP19H Digital Meat Thermometer for Cooking, Ambidextrous Backlit, Waterproof Kitchen BBQ Grill", imageId: "41lMXKfFqPL", priceCents: 1299 },
  { asin: "B01IHHLB3W", title: "ThermoPro TP03B Digital Instant Read Meat Thermometer, Kitchen Food Thermometer for Grill BBQ Smoker", imageId: "4147s9RhYOL", priceCents: 1799 },
  { asin: "B079DRC97N", title: "Digital Instant Read Meat Thermometer - Waterproof Kitchen Food Cooking, Backlight LCD, BBQ Grilling", imageId: "51Rb2cY9inL", priceCents: 569 },

  // Kitchen Scales
  { asin: "B0113UZJE2", title: "Etekcity Food Kitchen Scale, Digital Grams and Ounces for Baking, Cooking, 304 Stainless Steel", imageId: "21mfYj1UciL", priceCents: 1399 },
  { asin: "B08QMJY273", title: "Etekcity 0.1g Food Kitchen Scale, Digital Ounces and Grams for Cooking and Baking, 11lb/5kg", imageId: "21mfYj1UciL", priceCents: 1899 },
  { asin: "B09HM2TN5Z", title: "Etekcity Digital Food Kitchen Scale, IPX6 Waterproof, USB Rechargeable, 22lb, Stainless Steel Silver", imageId: "51tWKyWQM3L", priceCents: 2999 },

  // Vegetable Choppers & Mandoline Slicers
  { asin: "B0764HS4SL", title: "Fullstar The Original Pro Chopper - Vegetable Chopper and Spiralizer, Food Chopper with Container, 4 in 1", imageId: "51MFuS3gwQL", priceCents: 2699 },
  { asin: "B07VG4S38C", title: "Fullstar XL Vegetable Chopper & Mandoline Slicer, Onion Potato Food Slicer, Dicer & Spiralizer, 6 in 1", imageId: "51B1EJjuz3L", priceCents: 4299 },
  { asin: "B0BHSXFTGH", title: "Fullstar Mandoline Slicer for Kitchen, Vegetable Chopper, Onion Potato Food Slicer and Cutter, 6-in-1", imageId: "51YrBHDC+JL", priceCents: 1996 },
  { asin: "B08N9Q24M9", title: "Mueller The Real Original Pro Chopper since 2013, 8 Blade Vegetable Chopper Mandoline Slicer, 10 in 1", imageId: "512e7W+71PL", priceCents: 2699 },
  { asin: "B07FZL4C54", title: "PrepNaturals 8-in-1 Vegetable Chopper With Container, Mandoline Slicer, Onion Slicer, Salad Chopper", imageId: "21JvelPjYnL", priceCents: 2599 },
  { asin: "B015HONRP8", title: "OXO Good Grips Large Adjustable Handheld Mandoline Slicer, Stainless Steel Blade, Non-Slip Grip", imageId: "41nSFRVyT0L", priceCents: 3495 },

  // Graters & Zesters
  { asin: "B00004S7V8", title: "Microplane Classic Zester Grater, Black - Lemon Zester, Cheese Grater, Citrus, Parmesan, Garlic", imageId: "31IjAQSgn7L", priceCents: 1299 },
  { asin: "B00151WA06", title: "Microplane Premium Classic Series Zester, Black - Lemon Zester, Cheese Grater, Stainless Steel, Made in USA", imageId: "313UAorevsL", priceCents: 1795 },
  { asin: "B07V39LSRY", title: "OXO Good Grips Etched Zester and Grater, Stainless Steel Blade, Non-Slip Handle", imageId: "31F+mPr+SnL", priceCents: 1297 },

  // Cocktail Smokers & Smoke Guns
  { asin: "B07YFJWYNX", title: "TMKEFFC Smoking Gun Portable Smoker Infuser, Handheld Indoor and Outdoor Cocktail Smoke Generator Tool", imageId: "41L7G6RZsML", priceCents: 3695 },
  { asin: "B0B6JKNJJC", title: "Home Hero Whiskey Smoker Kit - Cocktail Smoker for Old Fashioned & Bourbon, Indoor Cold Smoke Generator", imageId: "11SZyH2kDLL", priceCents: 2299 },
  { asin: "B072RCDQJS", title: "Breville BSM600SIL Smoking Gun, Handheld Food and Cocktail Smoker, Silver", imageId: "41WgWQcOAhL", priceCents: 9999 },

  // Unique Kitchen Gadgets & Tools
  { asin: "B084XBBY5C", title: "Avocado Slicer Tool 3-in-1, Ergonomic Handle, Easy to Use and Clean, Food-Grade Plastic & Stainless Steel", imageId: "41uqGHOrt1L", priceCents: 699 },
  { asin: "B07D6Y61KL", title: "KitchenIQ 2-Pack 2-in-1 Stainless Steel Pizza Cutter & Dual Blade Herb Mincer Roller With Cover", imageId: "51t49zyhkdL", priceCents: 1400 },
  { asin: "B00004OCKR", title: "OXO Good Grips Salad Spinner, Lettuce Spinner, Fruit Washer, Large, BPA-Free", imageId: "41f+o0rf8UL", priceCents: 3295 },
  { asin: "B09J746BHB", title: "Alpha Grillers Meat Shredder Claws - Grilling Accessories, BBQ Pulled Pork Wolverine Bear Claws", imageId: "51z3bJJEqJL", priceCents: 1499 },
  { asin: "B07D1KW3PB", title: "Saucemoto Dip Clip - An in-car Sauce Holder for Ketchup and Dipping Sauces, Car Accessory", imageId: "41VrYvyl+YL", priceCents: 650 },
  { asin: "B076CTTZKX", title: "OTOTO Gracula Garlic Crusher, Garlic Mincer, Vampire Dracula Shaped, Silicone Kitchen Gadget", imageId: "21A+TdOprGL", priceCents: 1597 },

  // Blenders & Appliances
  { asin: "B07JHVJ1ZS", title: "Instant Blend Ace Cold and Hot Blender for Soups, Sauce, Dips, Drinks and Smoothies, Stainless Steel", imageId: "4131LH9KJgL", priceCents: 8999 },
  { asin: "B09MZTP44L", title: "Instant Pot Whisper Quiet 9-in-1 Electric Pressure Cooker, Slow Rice Steamer, 6-Quart, Stainless Steel", imageId: "415iYMNnu2L", priceCents: 9995 },
  { asin: "B0758JHZM3", title: "Vitamix Explorian E310 Blender, Professional-Grade Kitchen Blender for Smoothies and More", imageId: "31vaq8tA8iL", priceCents: 37499 },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchProductPage(asin: string): string {
  const url = `https://www.amazon.com/dp/${asin}`;
  return execSync(
    [
      "curl -s -L --max-time 20",
      '-H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"',
      '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"',
      '-H "Accept-Language: en-US,en;q=0.9"',
      '-H "Accept-Encoding: identity"',
      `"${url}"`,
    ].join(" "),
    { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }
  );
}

function parseProductPage(html: string, asin: string): ScrapedProduct | null {
  // Extract title
  let title = "";
  const titleMatch = html.match(/id="productTitle"[^>]*>\s*([^<]+)/);
  if (titleMatch) {
    title = titleMatch[1].trim().replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  } else {
    const metaTitleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (metaTitleMatch) {
      title = metaTitleMatch[1]
        .replace(/Amazon\.com:\s*/, "")
        .replace(/\s*:\s*Home &amp; Kitchen.*/, "")
        .replace(/\s*:\s*Home & Kitchen.*/, "")
        .replace(/\s*:\s*Patio, Lawn &amp; Garden.*/, "")
        .replace(/\s*:\s*Industrial &amp; Scientific.*/, "")
        .trim();
    }
  }
  if (!title || title.length < 10) return null;

  // Extract image
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
      } else {
        // For mobile pages, find the main product thumbnail
        const mobileImg = html.match(/https:\/\/m\.media-amazon\.com\/images\/I\/([A-Za-z0-9+]+L)\._SS210_\.jpg/);
        if (mobileImg) {
          imageUrl = `https://m.media-amazon.com/images/I/${mobileImg[1]}._AC_SL1500_.jpg`;
        }
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

  return { asin, title, image_url: imageUrl, price_cents: priceCents, category: CATEGORY };
}

// Search queries relevant to cooking gadgets
const COOKING_SEARCHES = [
  "kitchen gadget unique innovative cooking",
  "air fryer accessories popular best",
  "sous vide precision cooker kitchen",
  "kitchen scale digital food baking",
  "vegetable spiralizer kitchen tool",
  "mandoline slicer kitchen gadget best",
  "meat thermometer instant read digital",
  "cocktail smoker kit whiskey bourbon",
  "kitchen gadget gift set cooking tool",
  "cast iron skillet cooking accessory",
];

function fetchSearchPage(query: string): string {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.amazon.com/s?k=${encodedQuery}`;
  return execSync(
    [
      "curl -s -L --max-time 20",
      '-H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"',
      '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"',
      '-H "Accept-Language: en-US,en;q=0.9"',
      '-H "Accept-Encoding: identity"',
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
  console.log(`=== Cooking Gadgets Product Scraper ===\n`);

  // Load existing ASINs
  const existingAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) existingAsins.add(r.asin);
  console.log(`Existing products in DB: ${existingRows.length}`);

  const allProducts: ScrapedProduct[] = [];
  const seenAsins = new Set(existingAsins);
  let captchaCount = 0;

  // Phase 1: Try live scraping of curated ASINs (mobile UA)
  console.log(`\n--- Phase 1: Live scraping ${PRODUCT_DATA.length} curated ASINs ---`);
  let scraped = 0;
  let failed = 0;
  let captchaBlocked = 0;
  let skippedExisting = 0;

  for (const entry of PRODUCT_DATA) {
    if (seenAsins.has(entry.asin)) {
      skippedExisting++;
      process.stdout.write(`  ${entry.asin}: already in DB, skipping\n`);
      continue;
    }

    process.stdout.write(`  ${entry.asin}: `);
    try {
      const html = fetchProductPage(entry.asin);

      if (html.includes("captcha") || html.includes("validateCaptcha")) {
        captchaCount++;
        captchaBlocked++;
        console.log("CAPTCHA!");
        if (captchaCount >= 3) {
          console.log("  Captcha wall -- switching to fallback data for remaining...");
          break;
        }
        await sleep(15000);
        continue;
      }
      captchaCount = 0;

      const product = parseProductPage(html, entry.asin);
      if (product) {
        seenAsins.add(entry.asin);
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

  console.log(`\nPhase 1 complete: ${scraped} live-scraped, ${failed} failed, ${captchaBlocked} CAPTCHA, ${skippedExisting} already in DB`);

  // Phase 1b: Use curated fallback data for any products not yet added
  const missingProducts = PRODUCT_DATA.filter(p => !seenAsins.has(p.asin));
  if (missingProducts.length > 0) {
    console.log(`\n--- Phase 1b: Using verified curated data for ${missingProducts.length} remaining products ---`);
    for (const entry of missingProducts) {
      const imageUrl = `https://m.media-amazon.com/images/I/${entry.imageId}._AC_SL1500_.jpg`;
      const product: ScrapedProduct = {
        asin: entry.asin,
        title: entry.title,
        image_url: imageUrl,
        price_cents: entry.priceCents,
        category: CATEGORY,
      };
      seenAsins.add(entry.asin);
      allProducts.push(product);
      console.log(`  ${entry.asin}: CURATED - ${entry.title.substring(0, 50)} ($${(entry.priceCents / 100).toFixed(2)})`);
    }
  }

  // Phase 2: Try search queries for more products
  console.log(`\n--- Phase 2: Searching for more cooking gadgets ---`);
  const targetTotal = 100;
  captchaCount = 0;

  for (const query of COOKING_SEARCHES) {
    if (allProducts.length >= targetTotal) break;

    process.stdout.write(`  "${query}"... `);
    try {
      const html = fetchSearchPage(query);

      if (html.includes("captcha") || html.includes("validateCaptcha")) {
        captchaCount++;
        console.log("CAPTCHA!");
        if (captchaCount >= 3) {
          console.log("  Captcha wall -- skipping remaining searches.");
          break;
        }
        await sleep(15000);
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
      } else {
        // Try without _AC_SL1500_ suffix
        const altUrl = p.image_url.replace(/\._AC_SL1500_\.jpg$/, ".jpg");
        const altRes = await fetch(altUrl, { method: "HEAD" });
        const altLen = parseInt(altRes.headers.get("content-length") || "0");
        if (altRes.ok && altLen > 500) {
          p.image_url = altUrl;
          verifiedProducts.push(p);
        } else {
          console.log(`  ${p.asin}: image failed, dropped`);
        }
      }
    } catch {
      console.log(`  ${p.asin}: image fetch error, dropped`);
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
  const cookingCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }).c;
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;
  console.log(`\n"${CATEGORY}" category now has ${cookingCount} active products`);
  console.log(`Database total active products: ${totalCount}`);
  console.log("\nDone!");
}

main().catch(console.error);
