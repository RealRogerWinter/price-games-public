import { execSync } from "child_process";
import db from "../src/db";

/**
 * Scrapes specific Amazon products by ASIN for the "Figurines" category.
 * ASINs sourced from Amazon product pages, listicles, and best-seller lists
 * covering anime figures, Marvel/DC figures, Star Wars, garden statues,
 * Funko Pops, model kits, and decorative figurines.
 */

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

const CATEGORY = "Figurines";

// Curated ASINs — figurines, statues, action figures, collectibles
const ASIN_LIST: string[] = [
  // Anime Figures — Dragon Ball
  "B00FHFBQIS", // TAMASHII NATIONS S.H. Figuarts Goku
  "B0C6LNF8HX", // TAMASHII NATIONS Dragon Ball Z Super Saiyan Goku Legendary S.H.Figuarts
  "B0BNLND4CS", // Bandai Dragon Stars Superhero Goku
  "B0BB3579F9", // Dragon Ball Super Saiyan Goku 4" Flash Figure
  "B07YXHMML6", // Dragon Ball Super Final Blast Super Saiyan Goku
  "B0B2177X6C", // DBZ Majin Buu / Kid Buu Action Figure Statue 8.5"
  "B0BTDT98CJ", // Bandai Dragon Ball Flash Series figure

  // Anime Figures — Demon Slayer
  "B093F4SJBD", // Banpresto Demon Slayer Vol.18 Tanjiro Kamado
  "B0BGXH2NWJ", // Banpresto Demon Slayer Vol.28 Tanjiro Kamado Statue
  "B0D7N24YTN", // Banpresto Demon Slayer Tanjiro Kamado ver.B Figure EX
  "B09K6DWH4N", // Banpresto Demon Slayer MAXIMATIC Tanjiro Kamado II
  "B08XYJJ1KF", // Banpresto Demon Slayer Grandista Tanjiro Kamado

  // Anime Figures — One Piece
  "B0C3WLDG3X", // Banpresto One Piece King of Artist Luffy Gear 5
  "B0CYDBDZJ4", // Banpresto One Piece Grandista Monkey D. Luffy
  "B0CXHP15W5", // Banpresto One Piece King of Artist Luffy Gear 5 II
  "B0C671B85K", // Banpresto One Piece DXF Grandline Luffy Gear 5
  "B07FWGKTG6", // One Piece Grandline Men Grandista Luffy PVC Figure
  "B00MR95Q60", // Banpresto One Piece King of Artist Luffy Sculpture

  // Marvel / DC Figures
  "B0CP3F2M7C", // Marvel Legends Amazing Spider-Man Retro 6"
  "B0CFZD6HT7", // Marvel Legends Last Stand Spider-Man 6"
  "B07Q89M52X", // Marvel Legends Spider-Man Far From Home 6"
  "B083TGNQP4", // Hasbro Marvel Legends Spider-Man Retro Collection
  "B0BKH9C113", // Marvel Legends Ben Reilly Spider-Man 6"
  "B0BS4QVFVH", // Marvel Legends Iron Man Mark 46 Civil War 6"
  "B07VZYX659", // Hasbro Marvel Legends Iron Man 6"
  "B0BS4F5544", // Marvel Legends Captain America Winter Soldier 6"
  "B0CSPR7M4R", // Marvel Legends Captain America Retro Secret Wars
  "B07V91H6HR", // McFarlane DC Multiverse Batman Todd McFarlane 7"
  "B0D9C62HJD", // McFarlane DC Multiverse Batman Classic TV Series 7"
  "B0DKVMLZTD", // McFarlane DC Multiverse Batman 1989 7"
  "B0D4WVFLZR", // McFarlane DC Multiverse Batman Reborn 7"
  "B0CB92ZMSR", // McFarlane DC Batman & Spawn 2-pack
  "B0CT5ZHW43", // McFarlane DC Batman vs Bane 7" 2-pack

  // Kotobukiya Marvel ARTFX Statues
  "B00F61JMKM", // Kotobukiya Marvel ArtFX+ Hulk Statue
  "B00L9YTJ3K", // Kotobukiya Iron Man Marvel Now ARTFX+ Statue
  "B00MJ18K6E", // Kotobukiya Deadpool Marvel Now ArtFX+ Statue
  "B07D8L6GY2", // Kotobukiya Marvel Scarlet Witch ARTFX+ Statue
  "B07JWV4LPK", // Kotobukiya Marvel Avengers Vision ARTFX+ Statue

  // Star Wars Black Series
  "B083ZZ3K4L", // Star Wars Black Series Darth Vader Empire Strikes Back 6"
  "B0CQJ2GQDC", // Star Wars Black Series Holocomm Darth Vader 6"
  "B084N63D8J", // Star Wars Black Series Carbonized Darth Vader 6"

  // Funko Pop Vinyl Figures
  "B0DGB5PDMB", // Funko Pop DC Superman 2025 Krypto
  "B0DBPGVVYN", // Funko Pop Jumbo Pokemon Suicune Amazon Exclusive
  "B0DGB5V79K", // Funko Pop Jumbo Superman 2025
  "B0DJRZC657", // Funko Pop Heroes Superman 2025 Guy Gardner
  "B0DGBZBJCC", // Funko Pop DC Superman 2025 Superman

  // Nendoroid / Good Smile
  "B0BX9HNQHN", // Good Smile Sonic the Hedgehog Nendoroid
  "B07GWTTDN5", // Good Smile Persona 5 Joker Nendoroid
  "B00PHY6MGU", // Good Smile Super Mario Nendoroid

  // Gundam Model Kits
  "B003KX5OXW", // Bandai RG RX-78-2 Gundam 1/144
  "B0091O14SI", // Bandai RG Zeta Gundam 1/144
  "B0BYYJHHWN", // Bandai RG Gundam Epyon 1/144
  "B00030EUA8", // Bandai MG Master Gundam
  "B000RHKZLU", // Bandai MG Turn A Gundam

  // NECA Collectible Figures
  "B00VESQD1M", // NECA Godzilla Video Game 12" Head-to-Tail
  "B07Q3XBFN8", // NECA Godzilla 2019 12" Head-to-Tail
  "B00IL5XY2W", // NECA Godzilla Classic '94 12" Head-to-Tail

  // Garden Statues & Decorative Figurines
  "B08ZMSZD4F", // WOGOON Garden Gnome Statue Solar Lantern
  "B08CVRXHL4", // LA JOLIE MUSE Solar Gnome Magic Orb 10.7"
  "B0CGV46JW1", // Starsoul Solar Funny Gnome Holds Bottle
  "B096H6RMXC", // Untimaty Garden Gnome Solar LED Wizard
  "B0CT4VT2YJ", // Starsoul Solar Gnome + Snail Combo
  "B098RMZGPZ", // grinshin Garden Gnome Solar LED Blue
  "B0CCD7MTKG", // Starsoul Gnome Riding Turtle Solar
  "B0BRQ6GLG5", // Garden Gnome Flower Hat Solar Light
  "B09NLVXL4P", // Ovewios Garden Gnome Solar Crackle Globe
  "B0BFWSP46F", // Starsoul Drunk Gnome Solar LED
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
];

function getRandomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function fetchProductPage(asin: string): string {
  const url = `https://www.amazon.com/dp/${asin}`;
  const ua = getRandomUA();
  return execSync(
    [
      "curl -s -L --max-time 20",
      `'-H' 'User-Agent: ${ua}'`,
      '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"',
      '-H "Accept-Language: en-US,en;q=0.9"',
      '-H "Accept-Encoding: identity"',
      '-H "Cache-Control: no-cache"',
      '-H "Pragma: no-cache"',
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

// Search queries for figurines to get more variety
const FIGURINE_SEARCHES = [
  "anime figure statue collectible",
  "action figure collectible Marvel",
  "marvel legends figure 6 inch",
  "garden statue figurine outdoor resin",
  "Funko Pop vinyl figure collectible",
  "dragon ball z figure statue",
  "demon slayer anime figure",
  "Star Wars Black Series figure",
  "Gundam model kit Bandai",
  "decorative figurine statue home",
  "NECA action figure collectible",
  "Nendoroid Good Smile figure",
];

function fetchSearchPage(query: string): string {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.amazon.com/s?k=${encodedQuery}`;
  const ua = getRandomUA();
  return execSync(
    [
      "curl -s -L --max-time 20",
      `'-H' 'User-Agent: ${ua}'`,
      '-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"',
      '-H "Accept-Language: en-US,en;q=0.9"',
      '-H "Accept-Encoding: identity"',
      '-H "Cache-Control: no-cache"',
      '-H "Pragma: no-cache"',
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
  console.log(`=== Figurines Product Scraper ===\n`);

  // Load existing ASINs
  const existingAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) existingAsins.add(r.asin);
  console.log(`Existing products in DB: ${existingRows.length}`);

  const allProducts: ScrapedProduct[] = [];
  const seenAsins = new Set(existingAsins);
  let captchaCount = 0;

  // Phase 1: Scrape individual ASINs from curated list
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
          console.log("  Captcha wall — waiting 120s...");
          await sleep(120000);
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

    // 10-20s delay between individual fetches to avoid captcha
    await sleep(10000 + Math.random() * 10000);
  }

  console.log(`\nPhase 1 complete: ${scraped} scraped, ${failed} failed`);

  // Phase 2: Search for more figurine products
  console.log(`\n--- Phase 2: Searching for more figurine products ---`);
  const targetTotal = 100;
  for (const query of FIGURINE_SEARCHES) {
    if (allProducts.length >= targetTotal) break;

    process.stdout.write(`  "${query}"... `);
    try {
      const html = fetchSearchPage(query);

      if (html.includes("captcha") || html.includes("validateCaptcha")) {
        captchaCount++;
        console.log("CAPTCHA!");
        if (captchaCount >= 3) {
          console.log("  Captcha wall — waiting 120s...");
          await sleep(120000);
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
  const figurineCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE category = ? AND is_active = 1").get(CATEGORY) as { c: number }).c;
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;
  console.log(`\n"${CATEGORY}" category now has ${figurineCount} active products`);
  console.log(`Database total active products: ${totalCount}`);
  console.log("\nDone!");
}

main().catch(console.error);
