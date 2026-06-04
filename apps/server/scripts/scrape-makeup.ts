import { execSync } from "child_process";
import db from "../src/db";

const CATEGORY = "Beauty & Personal Care";

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

const ASIN_LIST: string[] = [
  // Foundations
  "B00PFCSURS", // Maybelline Fit Me Matte + Poreless Liquid Foundation
  "B004675EI6", // Maybelline Fit Me Dewy + Smooth Foundation
  "B00L2SNFPQ", // L'Oreal Paris Magic Skin Beautifier BB Cream
  "B0841T83KH", // Jerome Alexander MagicMinerals AirBrush Foundation
  "B01H1V7WQU", // Laura Geller Balance-n-Brighten Powder Foundation
  "B0D2L1YLNR", // TIRTIR Mask Fit Red Cushion Foundation
  "B0F38QBPTN", // L'Oreal Paris Infallible Blur-fection Powder

  // Concealers
  "B004Y9GV60", // Maybelline Instant Age Rewind Eraser Dark Circles Concealer
  "B09V1CPTR1", // Catrice Under Eye Brightener
  "B00S5VHGQ2", // Tarte Shape Tape Concealer
  "B0DPB7K2XG", // Catrice Under Eye Brightener Setting Powder

  // Primers
  "B07NSH2B4D", // e.l.f. Poreless Face Primer
  "B09XMYFTB7", // e.l.f. Power Grip Primer
  "B073XTWVM6", // Elizabeth Mott Thank Me Later Face Primer
  "B018JDMD4K", // Elizabeth Mott Thank Me Later Eye Primer
  "B0030O9LYY", // NYX Professional Makeup Eyeshadow Base Primer
  "B004KFJANY", // NYX Studio Perfect Primer (Lavender)
  "B091J21GSY", // Maybelline Fit Me Matte + Poreless Primer SPF 20

  // Setting Sprays
  "B00B4YVU4G", // NYX Professional Makeup Matte Finish Setting Spray
  "B0CZF2T7CK", // L'Oreal Paris Infallible 3-Second Setting Spray
  "B07SB2LG6S", // NYX Bare With Me Primer & Setting Spray
  "B0BN4NW7D3", // Milani Make It Last Setting Spray + Primer
  "B086LK2FNL", // NYX Dewy Finish Setting Spray (Jumbo)

  // Mascaras
  "B00T0C9XRK", // essence Lash Princess False Lash Effect Mascara
  "B0BB6B581W", // Tarte Tartelette Tubing Mascara
  "B0CPFY2SZM", // e.l.f. Lash XTNDR Mascara
  "B0DK7XRDGW", // L'Oreal Paris Paradise Big Deal Mascara
  "B0DHYC41GD", // Almay Thickening & Tint Volume Mascara
  "B0DNLV82VY", // Lancome Lash Idole Flutter Extension Mascara
  "B0000531PS", // L'Oreal Voluminous Waterproof Mascara
  "B01D90BYKC", // theBalm Mad Lash Voluminous Mascara

  // Eyeliners
  "B074Y8LM6T", // NYX Professional Makeup Epic Ink Liner (Waterproof)
  "B006Z79SBE", // Urban Decay 24/7 Glide-On Waterproof Eyeliner
  "B07MWSXPT1", // e.l.f. No Budge Retractable Eyeliner
  "B0031NNE56", // Stila Stay All Day Waterproof Liquid Eye Liner
  "B07GM317JJ", // The Flick Stick Winged Eyeliner Stamp
  "B008VSJFQ8", // theBalm Schwing Liquid Eyeliner

  // Eyeshadow Palettes
  "B07LBLK57Q", // Urban Decay Naked 2 Basics Mini Eyeshadow Palette
  "B01LVYL8OU", // Julep Eyeshadow 101 Cream-to-Powder Shadow Stick
  "B00PGQYEUK", // L.A. Girl Beauty Brick Eyeshadow (Nudes)
  "B01CNZMMV4", // Lamora Best Pro Eyeshadow Palette (16 Colors)
  "B07BJ2JR4Y", // UCANBE Professional 18 Pigmented Eyeshadow Palette
  "B06WV7KPY2", // Stila Magnificent Metals Glitter & Glow Liquid Eyeshadow

  // Blush
  "B08KFPVVXY", // Rare Beauty Soft Pinch Liquid Blush (Joy)
  "B0BHFBBH25", // SHEGLAM Color Bloom Liquid Blush
  "B00518N2JC", // Milani Baked Blush (Luminoso)
  "B07GSK12RM", // Milani Rose Powder Blush (Tea Rose)
  "B0CPFXDKYP", // e.l.f. Primer-Infused Matte Blush
  "B0CXWP6XBY", // Fwee Blurry Pudding Pot
  "B00021DJ7I", // NARS Blush (Deep Throat)

  // Bronzer
  "B07ZR187P5", // e.l.f. Primer-Infused Bronzer (Forever Sun Kissed)
  "B09JL6MY7J", // e.l.f. Putty Bronzer (Tan Lines)
  "B079CFLTF2", // Milani Baked Bronzer (Dolce)
  "B00518N3VE", // Milani Baked Bronzer (Glow)
  "B0D6NF89NR", // essence Drop of Sunshine Bronzing Drops

  // Highlighters
  "B074PTZCNX", // L'Oreal Paris True Match Lumi Glotion
  "B0C6V67KJW", // e.l.f. Halo Glow Highlight Beauty Wand
  "B0D24BXNN1", // Kiss New York Pearl Highlight Wand
  "B006N0BEY2", // Milani Illuminating Face Powder (Beauty's Touch)

  // Lipstick & Lip Products
  "B09JL5PCJ6", // e.l.f. Hydrating Core Lip Shine
  "B0DHF9X19V", // Maybelline Super Stay Teddy Lip Tint
  "B079KG56CH", // Wet n Wild Silk Finish Lipstick
  "B0032RMX3U", // Clinique Almost Lipstick Tinted Lip Balm
  "B000YABG8Q", // MOODmatcher Color-Changing Lipstick
  "B083QNQQP9", // BestLand Matte Liquid Lipstick Set
  "B0CTKV894Y", // Wonderskin Lip Rehab Serum Oil
  "B0CZLRLP8W", // Naturium Phyto-Glow Lip Mask
  "B07CG7JCT8", // NOONI Korean Lip Oil
  "B07XXPHQZK", // LANEIGE Lip Sleeping Mask (Berry)
  "B07DY2YZW6", // LANEIGE Lip Glowy Balm
  "B08D3FXF64", // Tatcha Kissu Lip Mask
  "B0D24C27RG", // Covergirl Clean Fresh Yummy Gloss Plumper
  "B0F1P4KQ14", // NYX Smushy Matte Lip Balm

  // Brows
  "B074VD6LCB", // Maybelline Total Temptation Eyebrow Definer Pencil
  "B08M58SWB1", // NYX Professional Makeup The Brow Glue
  "B0D3FGY5D6", // e.l.f. Brow Laminating Gel
  "B004J37SRC", // Billion Dollar Brows Eyebrow Powder

  // Skincare - Serums
  "B00PBX3L7K", // COSRX Advanced Snail 96 Mucin Power Essence
  "B083RH5VJL", // Tatcha The Serum Stick
  "B0D1FX5GW8", // Elizabeth Arden Retinol + HPR Ceramide Capsules

  // Skincare - Moisturizers
  "B00TTD9BRC", // CeraVe Moisturizing Cream (19 oz)
  "B01LEJ5MSK", // COSRX Snail Mucin 92% Face Moisturizer
  "B072FH17NJ", // COSRX Hyaluronic Acid Moisturizing Cream
  "B077TQR6ZW", // CeraVe Ultra-Light Moisturizing Lotion SPF 30

  // Skincare - Sunscreen
  "B002MSN3QQ", // EltaMD UV Clear Face Sunscreen SPF 46
  "B09XQ1J1KG", // Beauty of Joseon Relief Sun Rice Probiotics SPF 50+
  "B09ZY7468X", // COSRX Vitamin E Vitalizing Sunscreen SPF 50

  // Skincare - Cleansers
  "B01MSSDEPK", // CeraVe Hydrating Facial Cleanser
  "B074PVTPBW", // Hero Mighty Patch Original (Acne Patches)

  // Makeup Brushes & Tools
  "B01F36JEXE", // BEAKEY Makeup Sponge Set (5 Pack)
  "B07LBNV469", // Daubigny Foundation Makeup Brush (Flat Top)
  "B07MH1KHJ2", // BS-MALL Makeup Brush Set (18 Pcs)
  "B01EWBYUDU", // EmaxDesign Makeup Brush Set (20 Pcs)
  "B07VBNQ367", // Beautyblender Original Pink Sponge
  "B082KZ8ZGM", // Revlon Oil-Absorbing Face Roller
  "B0787GLBMV", // Schick Hydro Silk Dermaplaning Tool
  "B012TVK2P0", // MakeUp Eraser Cloth
  "B07253DKHX", // Docolor Makeup Brushes (16 Pcs Fantasy Set)

  // Contour
  "B0CK3PXGN4", // MCoBeauty Instant Contour Beauty Wand

  // Nail Polish
  "B01E7UKT54", // Essie Gel Couture Top Coat
  "B000NG4778", // OPI Nail Lacquer (Black Onyx)
  "B016NCLKJI", // ILNP MEGA Ultra Holographic Nail Polish
  "B0BJ15K76W", // ILNP Nocturnal Black Holographic Shimmer
  "B0B8361CJY", // ILNP Horizon Gold Iridescent Holographic
  "B07SSMDJML", // ILNP On Repeat Icy Blue Holographic Shimmer
  "B0BWPT4SZJ", // Glamnetic Press-On Nails
  "B0037MIMLW", // CND SolarOil Cuticle Oil
  "B005HGWGVS", // Onyx Professional Hard as Hoof Nail Strengthening Cream

  // Perfume & Fragrance
  "B09C8VNWBP", // Lattafa Yara Eau de Parfum (Vanilla/Amber)
  "B0BRJ9YJ5Y", // Lattafa Yara Moi Eau de Parfum
  "B0CN9PWGGL", // Lattafa Khamrah Qahwa Eau de Parfum
  "B07JPZ95ZP", // Ariana Grande Cloud Eau de Parfum
  "B09X3HB2BR", // Sol de Janeiro Brazilian Crush Cheirosa 62
  "B005TT8RPM", // Al-Rehab Soft Concentrated Perfume Rollerball
  "B0BZDZJDTG", // Dossier Ambery Vanilla

  // Lashes
  "B07TZ6TKWF", // Arishine Magnetic Eyelashes with Eyeliner Kit

  // Body Care
  "B013XKHA4M", // Sol de Janeiro Brazilian Bum Bum Cream
  "B000NKL3D0", // Curel Ultra Healing Intensive Lotion
];

const BEAUTY_SEARCHES = [
  "best drugstore makeup foundation concealer",
  "viral tiktok beauty products skincare",
  "makeup palette eyeshadow blush set",
  "korean skincare products serum essence",
  "perfume eau de parfum women bestseller",
  "nail polish gel kit manicure",
  "makeup brush set professional",
  "lipstick lip gloss tint balm",
  "mascara waterproof volumizing curling",
  "skincare moisturizer sunscreen spf",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function fetchProductPage(asin: string): string {
  const url = `https://www.amazon.com/dp/${asin}`;
  return execSync(
    [
      "curl -s -L --max-time 20",
      `-H "User-Agent: ${randomUA()}"`,
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
      `-H "User-Agent: ${randomUA()}"`,
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
  console.log(`=== Beauty & Personal Care Product Scraper ===\n`);

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
          console.log("  Captcha wall — waiting 180s...");
          await sleep(180000);
          captchaCount = 0;
        } else {
          await sleep(30000);
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

    await sleep(8000 + Math.random() * 7000);
  }

  console.log(`\nPhase 1 complete: ${scraped} scraped, ${failed} failed`);

  // Phase 2: Search for more beauty products
  console.log(`\n--- Phase 2: Searching for more beauty products ---`);
  const targetNew = 100;
  for (const query of BEAUTY_SEARCHES) {
    if (allProducts.length >= targetNew) break;

    process.stdout.write(`  "${query}"... `);
    try {
      const html = fetchSearchPage(query);

      if (html.includes("captcha") || html.includes("validateCaptcha")) {
        captchaCount++;
        console.log("CAPTCHA!");
        if (captchaCount >= 3) {
          console.log("  Captcha wall — waiting 180s...");
          await sleep(180000);
          captchaCount = 0;
        } else {
          await sleep(30000);
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

    await sleep(12000 + Math.random() * 8000);
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
