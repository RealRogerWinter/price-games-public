import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import db from "../db";

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║        COMPREHENSIVE AMAZON PRODUCT SCRAPING PIPELINE       ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║                                                              ║
 * ║  Three scraping modes, one pipeline:                         ║
 * ║                                                              ║
 * ║  1. SEARCH MODE  — Scrape Amazon search results pages.       ║
 * ║     Fast: ~20 real products per query. Best for filling      ║
 * ║     categories with diverse products.                        ║
 * ║                                                              ║
 * ║  2. ASIN MODE    — Scrape individual Amazon product pages    ║
 * ║     by ASIN. Slower (6-12s per product) but targets exact    ║
 * ║     products. Feed ASINs from a file or command line.        ║
 * ║                                                              ║
 * ║  3. DISCOVER MODE — Web-search blogs & listicles for         ║
 * ║     "best Amazon [category] products", extract ASINs from    ║
 * ║     article links, then scrape those ASINs individually.     ║
 * ║     Finds curated, interesting products.                     ║
 * ║                                                              ║
 * ║  ALL DATA IS SCRAPED FROM REAL HTML. NOTHING IS FABRICATED.  ║
 * ║  If we can't extract real data, the product is skipped.      ║
 * ║                                                              ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   # Search mode (default) — fill categories from Amazon search results
 *   npx tsx src/pipeline/scrape-amazon.ts search
 *   npx tsx src/pipeline/scrape-amazon.ts search --category Kitchen
 *
 *   # ASIN mode — scrape specific ASINs
 *   npx tsx src/pipeline/scrape-amazon.ts asin --file asins.txt --category Electronics
 *   npx tsx src/pipeline/scrape-amazon.ts asin --asins B0D1XD1ZV3,B00FLYWNYQ --category Kitchen
 *
 *   # Discover mode — find ASINs from blogs, then scrape them
 *   npx tsx src/pipeline/scrape-amazon.ts discover --category "Weird and Wonderful"
 *
 *   # Options available to all modes:
 *   --dry-run          Preview only, no DB changes
 *   --category X       Process single category
 *   --target N         Products per category (default 100)
 */

// ============================================================
// TYPES
// ============================================================

interface ScrapedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
  scraped_at: string;
  manufacturer?: string;
}

// ============================================================
// SHARED UTILITIES
// ============================================================

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

function is404(html: string): boolean {
  return html.includes("Page Not Found") || html.includes("dogsofamazon");
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
// MODE 1: SEARCH — Parse Amazon search result pages
// ============================================================

function fetchSearchPage(query: string): string {
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
  return curlFetch(url);
}

function parseSearchResults(html: string, category: string): ScrapedProduct[] {
  const products: ScrapedProduct[] = [];
  const now = new Date().toISOString();

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

    // Image
    const imgMatch = chunk.match(/<img[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (!imgMatch) continue;
    const imageUrl = imgMatch[1]
      .replace(/_AC_UY\d+_/, "_AC_SL1500_")
      .replace(/_AC_UL\d+_/, "_AC_SL1500_")
      .replace(/_SS\d+_/, "_AC_SL1500_")
      .replace(/_AC_SR\d+,\d+_/, "_AC_SL1500_");

    // Title: longest relevant <span> text
    const spanTexts = chunk.match(/<span[^>]*>([^<]{20,300})<\/span>/g) || [];
    let title = "";
    const skipPhrases = [
      "bought in past", "Overall Pick", "sustainability", "recycled",
      "certification", "Check each", "Click to see", "free of Amazon",
      "certified by Amazon", "small business brands", "commitment to empowering",
      "Shop products from", "Carbon emissions", "lifecycle of this product",
      "Products highlighted", "Climate Pledge", "Best Seller", "Amazon's Choice",
    ];
    for (const s of spanTexts) {
      const text = s.replace(/<[^>]+>/g, "").trim();
      if (skipPhrases.some((p) => text.includes(p))) continue;
      const decoded = decodeHtmlEntities(text);
      if (decoded.length > title.length) title = decoded;
    }
    if (!title || title.length < 15) continue;

    // Price
    const priceMatch = chunk.match(/a-offscreen">\$([0-9,]+\.[0-9]{2})/);
    if (!priceMatch) continue;
    const priceCents = Math.round(parseFloat(priceMatch[1].replace(/,/g, "")) * 100);
    if (priceCents < 100 || priceCents > 1000000) continue;

    products.push({ asin, title, image_url: imageUrl, price_cents: priceCents, category, scraped_at: now });
  }

  return products;
}

// ============================================================
// MODE 2: ASIN — Scrape individual Amazon product pages
// ============================================================

type AsinResult =
  | { status: "ok"; product: ScrapedProduct }
  | { status: "captcha" }
  | { status: "not_found" }
  | { status: "no_data" };

function scrapeProductPage(asin: string, category: string): AsinResult {
  try {
    const html = curlFetch(`https://www.amazon.com/dp/${asin}`, 15);

    if (isCaptcha(html)) return { status: "captcha" };
    if (is404(html)) return { status: "not_found" };

    // Title — try productTitle id first, fallback to <title> tag
    let title: string | null = null;
    const productTitle = html.match(/id="productTitle"[^>]*>\s*([^<]+)/);
    if (productTitle) {
      title = productTitle[1].trim();
    } else {
      const titleTag = html.match(/<title[^>]*>([^<]+)/);
      if (titleTag) {
        title = titleTag[1]
          .replace(/ : Amazon\.com.*/, "")
          .replace(/ - Amazon\.com.*/, "")
          .replace(/Amazon\.com:\s*/, "")
          .trim();
      }
    }
    if (!title || title.length < 10) return { status: "no_data" };
    title = decodeHtmlEntities(title);

    // Price — first dollar amount
    const priceMatch = html.match(/\$([0-9,]+\.[0-9]{2})/);
    if (!priceMatch) return { status: "no_data" };
    const priceCents = Math.round(parseFloat(priceMatch[1].replace(/,/g, "")) * 100);
    if (priceCents < 100 || priceCents > 1000000) return { status: "no_data" };

    // Image — try hiRes, large, og:image, landingImageUrl in that order
    let imageUrl: string | null = null;
    const hiRes = html.match(/"hiRes":"(https:\/\/[^"]+)"/);
    if (hiRes) imageUrl = hiRes[1];
    if (!imageUrl) {
      const large = html.match(/"large":"(https:\/\/[^"]+)"/);
      if (large) imageUrl = large[1];
    }
    if (!imageUrl) {
      const og = html.match(/property="og:image"\s+content="(https:\/\/[^"]+)"/);
      if (og) imageUrl = og[1];
    }
    if (!imageUrl) {
      const landing = html.match(/"landingImageUrl"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
      if (landing) {
        // Upgrade to high-res
        const id = landing[1].match(/\/I\/([A-Za-z0-9+_-]+)\./)?.[1];
        if (id) imageUrl = `https://m.media-amazon.com/images/I/${id}._AC_SL1500_.jpg`;
      }
    }
    if (!imageUrl) return { status: "no_data" };

    // Manufacturer/Brand — try bylineInfo, then "Brand:" row in detail table
    let manufacturer: string | undefined;
    const byline = html.match(/id="bylineInfo"[^>]*>(?:<[^>]+>)*\s*(?:Visit the\s+|Brand:\s*)?([^<]+)/i);
    if (byline) {
      manufacturer = byline[1].replace(/\s+Store$/, "").trim();
    }
    if (!manufacturer) {
      const brandRow = html.match(/(?:Brand|Manufacturer)[^<]*<\/th>\s*<td[^>]*>\s*(?:<[^>]+>)*\s*([^<]+)/i);
      if (brandRow) manufacturer = brandRow[1].trim();
    }
    // Sanitize manufacturer extracted from raw HTML: decode entities, strip
    // non-printable chars, and cap length.
    if (manufacturer) {
      manufacturer = manufacturer
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/[^\x20-\x7E]/g, "")
        .trim()
        .slice(0, 100) || undefined;
    }

    return {
      status: "ok",
      product: {
        asin, title, image_url: imageUrl, price_cents: priceCents,
        category, scraped_at: new Date().toISOString(),
        manufacturer: manufacturer || undefined,
      },
    };
  } catch {
    return { status: "no_data" };
  }
}

// ============================================================
// MODE 3: DISCOVER — Extract ASINs from blog/listicle pages
// ============================================================

function extractAsinsFromUrl(url: string): string[] {
  try {
    const html = curlFetch(url, 15);
    // Find Amazon product links: /dp/ASIN or /gp/product/ASIN
    const dpPattern = /(?:\/dp\/|\/gp\/product\/)([A-Z0-9]{10})/g;
    const asins = new Set<string>();
    let m;
    while ((m = dpPattern.exec(html)) !== null) {
      asins.add(m[1]);
    }
    // Also look for tag=* affiliate links which encode ASINs
    const affiliatePattern = /amazon\.com[^"'\s]*\/([A-Z0-9]{10})(?:\/|\?|"|')/g;
    while ((m = affiliatePattern.exec(html)) !== null) {
      if (/^B0[A-Z0-9]{8}$/.test(m[1])) asins.add(m[1]);
    }
    return Array.from(asins);
  } catch {
    return [];
  }
}

// Google search for blog articles about a category
function searchForBlogs(category: string): string[] {
  const queries = [
    `best Amazon ${category} products 2025 site:buzzfeed.com OR site:today.com OR site:nytimes.com`,
    `top Amazon ${category} finds 2025`,
    `most popular Amazon ${category} products`,
    `viral Amazon ${category} must have`,
  ];

  const urls: string[] = [];
  for (const query of queries) {
    try {
      const encodedQ = encodeURIComponent(query);
      const html = curlFetch(`https://www.google.com/search?q=${encodedQ}&num=5`, 15);
      // Extract URLs from Google results
      const urlPattern = /href="(https?:\/\/(?:www\.)?(?!google\.com)[^"]+)"/g;
      let m;
      while ((m = urlPattern.exec(html)) !== null) {
        const u = m[1];
        // Skip Google's own URLs, cache, etc.
        if (!u.includes("google.com") && !u.includes("webcache") && !u.includes("translate.google")) {
          urls.push(u);
        }
      }
    } catch { /* skip failed searches */ }
  }
  return [...new Set(urls)];
}

// ============================================================
// SEARCH QUERIES — 19 categories
// ============================================================

const CATEGORY_SEARCHES: Record<string, string[]> = {
  Fashion: [
    "levi 501 original jeans men", "nike air force 1 sneakers", "dr martens 1460 boots",
    "new balance 574 sneakers", "crocs classic clogs", "carhartt beanie knit watch hat",
    "champion reverse weave hoodie", "hanes tagless t-shirt pack", "ray-ban wayfarer sunglasses",
    "levi trucker jacket denim", "adidas ultraboost running shoes", "columbia fleece jacket men",
    "north face puffer vest", "birkenstock arizona sandals", "converse chuck taylor high top",
    "wrangler cowboy cut jeans", "dickies work pants original", "fossil leather belt men",
    "timberland premium waterproof boots", "calvin klein boxer briefs pack",
    "herschel retreat backpack", "under armour polo shirt men", "coach crossbody bag women",
    "ugg classic short boots women", "kate spade tote bag", "skechers go walk shoes women",
    "brooks ghost running shoes women", "gap hoodie pullover fleece", "tommy hilfiger polo shirt",
    "michael kors watch women gold", "casio g-shock digital watch", "puma suede classic sneakers",
    "reebok classic leather shoes", "asics gel-kayano running shoes", "vans old skool sneakers",
    "nike dunk low retro shoes", "lululemon belt bag", "fjallraven kanken backpack classic",
    "lee relaxed fit jeans women", "dockers khaki pants men",
    // Bestseller expansion — diverse popular items
    "samsonite luggage carry on spinner", "oakley holbrook sunglasses",
    "carhartt wip detroit jacket", "stance socks men athletic",
    "osprey daylite backpack", "allbirds wool runner shoes",
    "bombas ankle socks women", "tumi alpha passport cover",
  ],
  Electronics: [
    "apple airpods pro 2", "sony wh-1000xm5 headphones", "bose quietcomfort headphones",
    "jbl flip 6 bluetooth speaker", "amazon echo dot 5th gen", "amazon fire tv stick 4k",
    "logitech mx master 3s mouse", "samsung galaxy buds 2 pro", "roku streaming stick 4k",
    "anker powercore 10000 portable charger", "apple airtag tracker", "ring video doorbell",
    "kindle paperwhite 2024", "gopro hero 12 black", "razer deathadder v3 gaming mouse",
    "corsair k70 mechanical keyboard", "blue yeti usb microphone", "elgato stream deck mk2",
    "samsung t7 portable ssd 1tb", "sandisk 256gb micro sd card", "tp link kasa smart plug",
    "wyze cam v3 security camera", "anker usb c hub multiport", "apple watch series 9",
    "lg c3 oled 55 inch tv", "logitech c920 webcam", "hyperx cloud ii gaming headset",
    "asus rog strix gaming monitor 27", "playstation 5 dualsense controller",
    "xbox series x controller", "nintendo switch pro controller", "apple macbook air m3",
    "anker soundcore motion boom speaker", "sonos beam soundbar", "tile mate bluetooth tracker",
    "beats studio buds plus", "steelseries arctis nova 7 headset", "google pixel 9 phone",
    "samsung galaxy tab s9", "sony wf-1000xm5 earbuds",
    // Bestseller expansion — diverse popular items
    "roomba robot vacuum i3", "eufy security video doorbell",
    "tp-link deco mesh wifi system", "anker 735 charger nano ii",
    "backbone one mobile game controller", "secretlab titan gaming chair",
    "elgato key light air", "keychron k2 wireless keyboard",
  ],
  Jewelry: [
    "pandora moments charm bracelet", "swarovski crystal tennis bracelet",
    "kendra scott elisa pendant necklace", "fossil women chronograph watch",
    "seiko presage automatic watch men", "citizen eco drive watch men",
    "alex and ani charm bangle", "kate spade stud earrings", "gorjana layered necklace gold",
    "casio vintage digital watch gold", "orient bambino automatic watch",
    "timex weekender watch", "g-shock ga2100 casioak watch", "baublebar statement earrings",
    "sterling silver hoop earrings women", "pearl necklace freshwater genuine",
    "diamond stud earrings 14k gold", "moissanite engagement ring",
    "tungsten carbide wedding band men", "birthstone necklace sterling silver",
    "anklet gold plated women", "brooch vintage crystal", "cufflinks men sterling silver",
    "tie clip men gold", "cuban link chain necklace gold", "signet ring men silver",
    "opal ring women sterling silver", "garnet pendant necklace", "sapphire earrings stud",
    "claddagh ring irish", "evil eye bracelet gold", "locket necklace photo heart",
    "bangle bracelet women gold set", "watch men automatic skeleton",
    "charm bracelet women silver",
    // Bestseller expansion
    "mejuri croissant dome ring gold", "vitaly cuban chain stainless",
    "mvmt watch minimalist men", "miansai anchor bracelet leather",
    "missoma chunky hoop earrings", "monica vinader friendship bracelet",
  ],
  Beauty: [
    "cerave moisturizing cream", "maybelline lash sensational mascara",
    "revlon one-step hair dryer", "nyx butter gloss lip", "e.l.f. poreless putty primer",
    "olaplex no 3 hair perfector", "paula's choice 2% bha exfoliant",
    "the ordinary niacinamide serum", "cosrx snail mucin essence",
    "mighty patch pimple patches", "neutrogena hydro boost water gel",
    "elf halo glow liquid filter", "rare beauty soft pinch blush",
    "dyson airwrap multi styler", "shark flexstyle hair dryer",
    "laneige lip sleeping mask", "supergoop unseen sunscreen spf 40",
    "beauty blender original sponge", "real techniques makeup brush set",
    "benefit precisely my brow pencil", "urban decay all nighter setting spray",
    "it cosmetics cc cream", "tarte shape tape concealer", "fenty beauty gloss bomb",
    "mac studio fix powder foundation", "nars radiant creamy concealer",
    "clinique moisture surge moisturizer", "la roche posay anthelios sunscreen",
    "bioderma sensibio micellar water", "dermalogica daily microfoliant",
    "charlotte tilbury pillow talk lipstick", "drunk elephant protini moisturizer",
    "cerave hydrating cleanser", "morphe eyeshadow palette", "tatcha dewy skin cream",
    // Bestseller expansion
    "sol de janeiro bum bum cream", "tower 28 lip gloss",
    "gisou honey infused hair oil", "summer fridays jet lag mask",
    "k18 hair repair treatment", "merit flush balm lip cheek",
    "saie glowy super gel highlighter", "tatcha silk canvas primer",
  ],
  Kitchen: [
    "instant pot duo 7 in 1 6 quart", "kitchenaid classic stand mixer",
    "ninja air fryer max xl", "vitamix 5200 blender", "lodge cast iron skillet 12 inch",
    "keurig k-supreme coffee maker", "cuisinart food processor 14 cup",
    "oxo good grips kitchen scale", "le creuset dutch oven", "nespresso vertuo coffee machine",
    "aeropress coffee maker", "dash rapid egg cooker", "dash mini waffle maker",
    "fullstar vegetable chopper", "pyrex glass food storage set",
    "hydroflask water bottle 32oz", "stanley quencher tumbler 40oz",
    "brita water filter pitcher", "crock-pot slow cooker 7 quart",
    "kitchenaid hand mixer 5 speed", "mueller immersion blender",
    "oxo salad spinner large", "microplane premium zester grater",
    "wusthof pro chef knife 8 inch", "silicone baking mat set",
    "bamboo cutting board large", "countertop ice maker machine",
    "electric kettle gooseneck", "ninja creami ice cream maker",
    "breville smart oven air fryer", "chemex classic pour over",
    "cuisinart ice cream maker", "lodge enameled dutch oven",
    "rice cooker japanese zojirushi", "kitchenaid artisan stand mixer",
    // Bestseller expansion
    "our place always pan", "yeti rambler mug 14oz",
    "fellow stagg ekg electric kettle", "ember temperature control mug",
    "smeg retro toaster 2 slice", "vitamix food cycler composter",
    "caraway nonstick cookware set", "melitta pour over coffee cone",
  ],
  "Weird and Wonderful": [
    "yodeling pickle toy", "nicolas cage sequin pillow", "cat butt tissue holder",
    "inflatable t-rex costume adult", "finger hands mini hand puppets",
    "horse head mask latex", "pizza blanket round", "banana phone bluetooth",
    "screaming goat figurine", "burrito blanket tortilla", "bob ross chia pet",
    "toilet mug coffee cup", "bacon bandages novelty", "dumpster fire vinyl figure",
    "rubber chicken toy", "shark blanket hoodie wearable", "tiny hands finger puppets",
    "dad joke book funny", "emotional support pickle plush",
    "ostrich pillow travel", "ramen noodle pool float", "toilet golf potty putter",
    "cat astronaut costume pet", "nothing gift box gag", "emergency underpants novelty",
    "money toilet paper", "grow your own boyfriend gag gift",
    "handerpants finger underpants", "face bank coin eating box",
    "fake parking tickets prank pad",
    // Bestseller expansion
    "instant underpants just add water", "cactus cat scratcher",
    "giant stress ball jumbo", "mini brands surprise capsule",
    "ufo cow abduction lamp", "rear window heated cat bed",
  ],
  Costumes: [
    "inflatable dinosaur costume adult", "wednesday addams costume dress",
    "spiderman costume adult men", "wonder woman costume women adult",
    "beetlejuice costume men striped suit", "ghostface mask scream",
    "plague doctor mask costume", "pirate costume men adult",
    "witch costume women adult", "1920s flapper dress costume",
    "harley quinn costume adult", "batman costume adult",
    "stitch costume onesie adult", "barbie costume pink dress adult",
    "inflatable alien abduction costume", "groot costume adult",
    "morphsuit black bodysuit", "cleopatra costume women",
    "vampire cape dracula costume", "superhero cape masks kids party",
    "astronaut costume kids", "unicorn onesie pajamas adult",
    "banana costume adult funny", "hot dog costume adult",
    "taco costume food adult", "ninja costume kids",
    "fairy wings costume adult", "skeleton bodysuit glow dark",
    "bob ross costume wig palette", "led stick figure costume",
    // Bestseller expansion
    "stay puft marshmallow man costume", "where's waldo costume kit",
    "blow up sumo wrestler costume", "cruella deville costume women",
    "mario luigi costume adult", "chucky doll costume adult",
  ],
  Baby: [
    "chicco keyfit 30 infant car seat", "graco modes stroller",
    "baby bjorn carrier mini", "hatch rest sound machine baby",
    "nanit pro smart baby monitor", "comotomo baby bottle natural",
    "dr brown options+ bottle", "wubbanub infant pacifier",
    "muslin swaddle blanket set", "halo sleepsack wearable blanket",
    "ergobaby omni 360 carrier", "baby brezza formula pro dispenser",
    "boon grass drying rack", "bumbo floor seat baby",
    "fisher price kick play piano gym", "baby einstein take along tunes",
    "burt's bees baby pajamas", "aquaphor baby healing ointment",
    "waterwipes baby wipes sensitive", "pampers swaddlers size 1",
    "safety 1st magnetic cabinet locks", "munchkin bath toy letters numbers",
    "nuby ice gel teether keys", "skip hop activity center",
    "baby jogger city mini gt2", "graco pack n play playard",
    "lansinoh breastmilk storage bags", "uppababy vista v2 stroller",
    "owlet smart sock baby monitor", "desitin maximum diaper cream",
    // Bestseller expansion
    "lovevery play kit baby", "doona car seat stroller combo",
    "snoo smart bassinet", "tubby todd hair body wash baby",
    "jellycat bashful bunny plush", "lovevery montessori walker",
  ],
  Music: [
    "fender player stratocaster guitar", "yamaha fg800 acoustic guitar",
    "kala ka-15s soprano ukulele", "yamaha psr-e373 keyboard 61 key",
    "roland td-1dmk electronic drum kit", "shure sm58 microphone",
    "audio-technica at2020 condenser mic", "focusrite scarlett 2i2 audio interface",
    "ernie ball regular slinky guitar strings", "dunlop tortex guitar picks variety",
    "kyser capo quick change guitar", "snark clip-on chromatic tuner",
    "on-stage guitar stand", "korg tm60bk tuner metronome",
    "vic firth american classic drumsticks", "atlas sound mic stand boom",
    "hercules guitar wall mount hanger", "akai mpk mini mk3 midi controller",
    "audio-technica turntable at-lp60x", "crosley cruiser portable turntable",
    "beatles abbey road vinyl record", "fleetwood mac rumours vinyl",
    "pink floyd dark side moon vinyl", "miles davis kind of blue vinyl",
    "hohner special 20 harmonica key c", "kalimba thumb piano 17 key",
    "yamaha recorder soprano", "donner electric guitar beginner",
    "alesis nitro mesh electronic drum set", "native instruments komplete audio 1",
    // Bestseller expansion
    "loog mini acoustic guitar kids", "teenage engineering pocket operator",
    "arturia minilab 3 midi controller", "meinl djembe hand drum",
    "cordoba c5 classical guitar nylon", "boss katana 50 guitar amp",
  ],
  Collectibles: [
    "funko pop marvel spider-man", "funko pop star wars mandalorian",
    "funko pop anime one piece luffy", "pokemon booster box scarlet violet",
    "topps baseball series 1 2024", "panini nba prizm basketball cards",
    "hot wheels premium car culture set", "bandai gundam hg rx-78-2 model kit",
    "yu-gi-oh structure deck", "magic the gathering commander deck",
    "ultra pro card sleeves 100", "bcw top loader card holders",
    "display case acrylic collectibles", "funko pop protector case 10 pack",
    "morgan silver dollar coin", "coin collection starter kit",
    "stamp collecting starter kit", "lego star wars collectible helmet",
    "national geographic rock tumbler kit", "geode crystal collection kit",
    "sports memorabilia display frame", "comic book storage bags boards",
    "pokemon elite trainer box", "one piece card game booster",
    "baseball card binder pages",
    // Bestseller expansion
    "lego icons orchid botanical", "disney lorcana booster box",
    "hot wheels monster trucks 5 pack", "nendoroid good smile figure",
    "steiff teddy bear classic", "franklin mint collectible plate",
  ],
  Figurines: [
    "funko pop dc batman figure", "marvel legends action figure hasbro",
    "star wars black series darth vader", "mcfarlane dc multiverse figure",
    "neca horror figure pennywise", "bandai dragon ball z figure",
    "swarovski crystal figurine", "willow tree angel figurine",
    "precious moments figurine", "schleich dinosaur t-rex figure",
    "lego star wars darth vader helmet", "transformers optimus prime figure",
    "nintendo amiibo zelda figure", "pokemon select action figure pikachu",
    "wwe elite action figure", "godzilla neca action figure",
    "demon slayer figure banpresto", "one piece figure anime",
    "naruto shippuden figure", "design toscano garden statue",
    "balloon dog sculpture home decor", "crystal animal figurine glass",
    "ceramic cat figurine japanese", "fairy garden miniature set",
    "kotobukiya artfx statue marvel", "hot toys 1/6 scale figure",
    "my hero academia figure bandai", "gundam universe rx-78-2 figure",
    "chess set themed collectible", "bronze horse statue figurine",
    // Bestseller expansion
    "bearbrick medicom 400", "neca alien xenomorph figure",
    "figma max factory anime figure", "mezco one twelve collective",
    "jim shore disney traditions", "department 56 village christmas",
  ],
  Furniture: [
    "zinus green tea memory foam mattress queen", "furinno basic bookshelf 5 tier",
    "amazon basics mesh office chair", "walker edison farmhouse tv stand",
    "flash furniture bar stool metal", "novogratz brittany futon sofa",
    "flexispot standing desk electric", "homall gaming chair reclining",
    "christopher knight accent chair", "ashley furniture nightstand",
    "south shore dresser 6 drawer", "sauder beginnings computer desk",
    "dhp emily futon sofa bed", "modway articulate office chair",
    "round coffee table wood modern", "ottoman storage bench tufted",
    "floating wall shelf set", "shoe rack bench entryway",
    "kitchen island cart rolling", "vanity desk with mirror lights",
    "l-shaped desk corner gaming", "bar cabinet wine storage",
    "bean bag chair adult large", "recliner chair leather massage",
    "bunk bed twin over twin metal", "dining table set 4 chairs",
    "patio adirondack chair plastic", "murphy bed queen wall",
    "standing desk converter monitor riser", "bookshelf room divider",
    // Bestseller expansion
    "article sven sofa leather", "cb2 acacia nightstand",
    "thuma bed frame platform", "purple hybrid mattress queen",
    "herman miller aeron chair", "west elm mid century desk",
  ],
  "Home Decor": [
    "yankee candle large jar", "himalayan salt lamp natural",
    "led strip lights bedroom 50ft", "galaxy projector night light",
    "macrame wall hanging large", "throw pillow covers 18x18 velvet",
    "fleece throw blanket soft", "round wall mirror 24 inch",
    "floating shelves rustic wood set", "artificial succulent plants mini",
    "battery operated flameless candles", "essential oil diffuser",
    "tapestry wall hanging nature", "picture frame collage wall set",
    "blackout curtains bedroom", "area rug 5x7 modern",
    "desk lamp led adjustable", "wall clock modern minimalist",
    "ceramic vase set decorative", "string lights indoor bedroom",
    "lava lamp original 14 inch", "incense sticks variety pack",
    "wax warmer electric plug in", "neon sign custom led",
    "wind chimes outdoor memorial", "terrarium kit diy glass",
    "abstract canvas wall art", "door mat outdoor welcome funny",
    "hourglass sand timer large", "globe world map decorative",
    // Bestseller expansion
    "vitruvi stone essential oil diffuser", "smeg retro alarm clock",
    "hay neon tube led light", "areaware gradient puzzle 500",
    "paddywax candle apothecary", "cire trudon candle classic",
  ],
  Pet: [
    "kong classic dog toy large", "furbo dog camera 360",
    "chuckit ultra ball dog fetch", "furminator deshedding tool dog",
    "outward hound puzzle toy dog", "petsafe easy walk harness",
    "elevated dog bed cooling mesh", "pet fountain water cat stainless",
    "catit senses 2.0 digger cat toy", "yeowww catnip banana toy",
    "cat tree tower 72 inch", "litter-robot 4 automatic self-cleaning",
    "feliway classic calming diffuser", "greenies dental treats dog",
    "aqueon aquarium starter kit 10gal", "fluval plant nano aquarium light",
    "tetra whisper air pump aquarium", "kaytee clean cozy hamster bedding",
    "prevue hendryx flight cage bird", "dog car seat cover waterproof",
    "pet carrier airline approved soft", "dremel pet nail grinder",
    "earth rated dog poop bags", "pet stain odor remover enzyme",
    "slow feeder dog bowl puzzle", "cat scratcher lounge cardboard",
    "automatic pet feeder 6 meal", "seresto flea tick collar dog",
    "whistle go explore gps pet tracker", "reptihabitat bearded dragon kit",
    // Bestseller expansion
    "lickimat slow feeder cat", "pet acoustics bluetooth speaker dog",
    "floppy fish cat toy interactive", "kurgo dog harness car safety",
    "catit pixi smart feeder", "barkbox monthly dog toys chew",
  ],
  Foods: [
    "truff hot sauce truffle", "fly by jing sichuan chili crisp", "mike's hot honey",
    "nespresso vertuo capsules variety", "starbucks k-cups pike place",
    "wonderful pistachios roasted salted", "haribo goldbears gummy bears 5lb",
    "nerds gummy clusters candy", "quest protein bar variety pack",
    "celsius energy drink variety pack", "nutella hazelnut spread jar",
    "sriracha hot chili sauce", "tajin clasico seasoning",
    "ghee butter organic grass fed", "matcha powder ceremonial grade",
    "manuka honey umf 15+", "balsamic vinegar modena aged",
    "truffle oil black extra virgin", "chomps beef jerky sticks variety",
    "kind bars dark chocolate nuts", "rxbar protein bar variety pack",
    "blue diamond almonds smokehouse", "liquid death mountain water",
    "olipop prebiotic soda variety", "graza drizzle extra virgin olive oil",
    "maldon sea salt flakes", "poppi prebiotic soda variety pack",
    "laird superfood creamer", "everything bagel seasoning",
    "smart sweets gummy bears low sugar",
    // Bestseller expansion
    "momofuku chili crunch seasoning", "fishwife tinned smoked salmon",
    "bonne maman preserves gift set", "kodiak cakes pancake mix protein",
    "siete tortilla chips grain free", "hu chocolate bar dark vanilla",
  ],
  "Arts & Crafts": [
    "cricut maker 3 cutting machine", "prismacolor premier colored pencils 72",
    "copic sketch marker set", "winsor newton watercolor set",
    "mod podge gloss sealer", "resin art kit epoxy clear",
    "clay earring making kit polymer", "embroidery kit beginner",
    "calligraphy pen set beginner", "tie dye kit tulip",
    "candle making kit supplies", "crayola crayon box 120",
    "acrylic paint set 24 colors", "washi tape set decorative",
    "sewing machine singer heavy duty", "yarn skein variety pack crochet",
    "diamond painting kit round drill", "leather working tools kit",
    "pottery wheel electric mini", "airbrush kit compressor paint",
    "wood burning tool pyrography", "macrame cord 3mm natural",
    "paint pouring kit acrylic", "glass painting markers permanent",
    "needle felting kit animal", "soap making kit melt pour",
    "rock painting kit outdoor", "sketch pad 9x12 mixed media",
    "scrapbook album 12x12", "stamp making kit rubber",
    // Bestseller expansion
    "procreate brush set digital art", "posca paint marker set",
    "molotow liquid chrome marker", "liquitex acrylic ink set",
    "silhouette cameo 5 cutting machine", "brother se1900 embroidery machine",
  ],
  "Garden & Outdoor": [
    "weber original kettle grill 22", "solo stove bonfire fire pit",
    "adirondack chair polywood", "hammock double camping portable",
    "gazebo 10x10 pop up canopy", "string lights outdoor patio 48ft",
    "solar pathway lights garden", "raised garden bed galvanized steel",
    "miracle gro potting mix", "fiskars bypass pruning shears",
    "rain bird sprinkler timer", "bird feeder squirrel proof",
    "thermacell mosquito repeller", "cornhole boards regulation set",
    "coleman sundome 4 person tent", "yeti tundra 45 cooler",
    "osprey atmos ag 65 backpack", "kelty cosmic down sleeping bag",
    "eno doublenest hammock", "coleman quad camping chair",
    "black decker 20v cordless trimmer", "sun joe pressure washer electric",
    "greenworks 40v lawn mower", "traeger ironwood pellet grill",
    "keter deck storage box outdoor", "badminton set complete outdoor",
    "camp chef explorer stove", "igloo bmx 52 quart cooler",
    "scotts turf builder lawn food", "gardena expandable garden hose 50ft",
    // Bestseller expansion
    "ego power 56v chainsaw", "big green egg kamado grill",
    "pit boss pellet smoker", "worx landroid robotic mower",
    "oru kayak inlet foldable", "kelty low loveseat camp chair",
  ],
  Toys: [
    "lego botanical bonsai tree", "catan board game", "ticket to ride board game",
    "exploding kittens card game", "magna-tiles 100 piece set",
    "play-doh mega pack 36", "barbie dreamhouse dollhouse",
    "hot wheels ultimate garage", "nerf elite 2.0 commander",
    "rubik's cube speed 3x3", "jenga classic game", "connect 4 classic grid game",
    "squishmallow 16 inch plush", "pokemon trading card elite trainer",
    "lego technic bugatti chiron", "melissa doug wooden puzzle",
    "uno card game classic", "national geographic science kit",
    "thinkfun gravity maze marble", "ravensburger 1000 piece puzzle",
    "stomp rocket extreme outdoor", "bluey heeler family figurines",
    "transformers rise beast optimus", "paw patrol tower playset",
    "fisher price laugh learn puppy", "little tikes cozy coupe car",
    "radio flyer classic red wagon", "razor a5 lux kick scooter",
    "baby einstein take along tunes", "gabby's dollhouse playset",
    // Bestseller expansion
    "tonies audio player starter set", "toniebox creative figurine",
    "gravity maze thinkfun logic game", "osmo genius starter kit ipad",
    "snap circuits electronics discovery", "lite brite ultimate classic",
  ],
  "Tools & Home Improvement": [
    "dewalt 20v max drill driver kit", "milwaukee m18 impact driver",
    "makita 18v lxt circular saw", "bosch laser level cross line",
    "stanley fatmax tape measure 25ft", "leatherman wave plus multitool",
    "klein tools 11-in-1 screwdriver", "dremel 4300 rotary tool kit",
    "channellock 430 tongue groove pliers", "knipex cobra pliers 10 inch",
    "irwin quick-grip clamp set", "craftsman mechanics tool set 230",
    "dewalt tstak tool organizer", "ring floodlight cam wired pro",
    "nest learning thermostat", "schlage encode smart deadbolt",
    "lutron caseta dimmer switch kit", "hunter ceiling fan indoor 52",
    "gorilla glue original", "3m command strips picture hanging",
    "wagner flexio paint sprayer", "estwing hammer 16oz",
    "kreg pocket hole jig k5", "shop-vac wet dry vacuum 6 gallon",
    "generac gp3000i inverter generator", "ryobi 18v one+ drill combo",
    "worx wx523l circular saw", "zep industrial degreaser",
    "dap alex plus caulk", "irwin speed bore drill bit set",
    // Bestseller expansion
    "festool track saw ts 55", "milwaukee packout tool box",
    "huepar laser level 360", "wiha precision screwdriver set",
    "ridgid shop vac 14 gallon", "ecobee smart thermostat premium",
  ],
  "Sports & Fitness": [
    "bowflex selecttech 552 adjustable dumbbells", "peloton bike accessories mat",
    "manduka pro yoga mat 71 inch", "rogue fitness kettlebell cast iron",
    "theragun elite massage gun", "hydro flask wide mouth 32oz",
    "fitbit charge 6 fitness tracker", "nike metcon 9 training shoes",
    "concept2 model d rowing machine", "trx all in one suspension trainer",
    "trigger point foam roller grid", "harbinger padded leather weight belt",
    "resistance bands set exercise", "jump rope speed weighted crossfit",
    "pull up bar doorway iron gym", "ab roller wheel core workout",
    "nike dri-fit running shorts men", "under armour heatgear compression shirt",
    "adidas defender iv duffel bag", "yeti hopper flip 12 soft cooler",
    "garmin forerunner 265 running watch", "whoop 4.0 fitness strap",
    "normatec 3 leg recovery system", "hyperice hypervolt 2 pro",
    "reebok step aerobic platform", "sunny health rowing machine",
    "titan fitness power rack", "cap barbell olympic weight plates",
    "wilson nfl official football", "spalding nba official basketball",
    "everlast heavy bag boxing kit", "century wavemaster freestanding bag",
    "titleist pro v1 golf balls dozen", "callaway big bertha driver",
    "speedo vanquisher 2.0 swim goggles", "tyr sport alliance kickboard",
    "brooks glycerin 21 running shoes", "asics gel nimbus 26",
    "lululemon everywhere belt bag", "gymshark vital seamless leggings",
    "lacrosse ball mobility set", "battle ropes workout 30ft",
  ],
  Automotive: [
    "chemical guys car wash soap", "armor all cleaning wipes interior",
    "viofo a129 pro duo dash cam", "garmin dash cam mini 2",
    "weathertech floor mats custom fit", "husky liners floor mats",
    "thule roof rack cross bars", "yakima skybox cargo box rooftop",
    "noco boost plus gb40 jump starter", "battery tender junior charger",
    "carfidant scratch remover compound", "meguiars ultimate polish",
    "blackvue dr900x dash cam 4k", "rexing v1 dash cam 1080p",
    "michelin endurance xt tire gauge", "epauto tire inflator portable compressor",
    "turtle wax ice spray wax", "griots garage best of shine kit",
    "iottie easy one touch car mount", "ram mount x-grip phone holder",
    "led headlight bulbs 9005 h11", "auxbeam light bar 22 inch",
    "obd2 scanner bluedriver bluetooth", "foxwell nt301 car diagnostic tool",
    "covercraft sun shade windshield", "motor trend seat covers front",
    "portable car vacuum cleaner handheld", "bully dog gt tuner programmer",
    "k&n cold air intake kit", "flowmaster super 44 muffler",
    "rain-x latitude wiper blades", "bosch icon wiper blade",
    "scosche magicmount magnetic phone mount", "anker roav car charger bluetooth",
    "type s led interior car lights", "gorilla automotive lug nuts",
    "ctek battery charger maintainer", "optima redtop starting battery",
    "peak antifreeze coolant 50/50", "lucas oil stabilizer heavy duty",
  ],
  "Office & School Supplies": [
    "herman miller sayl office chair", "branch ergonomic desk chair",
    "autonomous smartdesk pro standing", "jarvis bamboo standing desk",
    "dell ultrasharp 27 monitor u2723qe", "lg 27 4k usb-c monitor",
    "brother color laser printer mfc", "hp laserjet pro printer",
    "pilot g2 gel pen 07 12 pack", "sharpie s-gel pens 0.7mm",
    "moleskine classic notebook large", "leuchtturm1917 bullet journal dotted",
    "post-it super sticky notes 3x3", "scotch heavy duty packaging tape",
    "swingline stapler 747 classic", "bostitch electric pencil sharpener",
    "fellowes paper shredder 12 sheet", "amazon basics document scanner",
    "kensington expert wireless trackball", "logitech ergo k860 keyboard",
    "benq screenbar monitor light", "elgato key light mini desk",
    "3m monitor mount dual arm", "vivo standing desk converter",
    "avery 5160 address labels", "dymo labelwriter 550 printer",
    "five star zipper binder 2 inch", "mead composition notebook 100 sheets",
    "ticonderoga pencils number 2 box 72", "expo dry erase markers 12 pack",
    "quartet cork bulletin board 36x24", "u brands glass dry erase board",
    "bankers box storage moving boxes", "sterilite stacking storage drawers",
    "desk organizer mesh metal", "monitor stand riser wood",
    "cable management raceway kit", "desk pad leather large",
    "blue light glasses computer screen", "acoustic desk divider panel",
  ],
  Gaming: [
    "playstation 5 slim console", "xbox series x console",
    "nintendo switch oled model", "steam deck oled 512gb",
    "meta quest 3 vr headset", "playstation portal remote player",
    "xbox elite wireless controller series 2", "scuf reflex pro ps5 controller",
    "razer wolverine v2 chroma controller", "8bitdo ultimate bluetooth controller",
    "secretlab titan evo gaming chair", "respawn 110 racing gaming chair",
    "razer blackwidow v4 mechanical keyboard", "corsair k100 rgb keyboard",
    "logitech g pro x superlight mouse", "razer viper v3 pro mouse",
    "steelseries arctis nova pro headset", "astro a50 wireless gaming headset",
    "elgato stream deck xl", "elgato hd60 x capture card",
    "corsair 4000d airflow pc case", "nzxt h7 flow mid tower case",
    "asus rog swift 27 gaming monitor", "alienware aw3423dwf curved monitor",
    "razer kiyo pro webcam streaming", "blue yeti x microphone usb",
    "lian li desk pad xl", "razer goliathus extended mouse pad",
    "corsair vengeance ddr5 32gb ram", "samsung 990 pro 2tb nvme ssd",
    "nzxt kraken x63 aio cooler", "corsair rm850x power supply",
    "razer seiren v3 chroma microphone", "rode podmic usb dynamic mic",
    "backbone one mobile controller iphone", "gamevice flex controller mobile",
    "gpu anti sag bracket support", "cable mod custom sleeved cables",
    "arcade1up street fighter cabinet", "retro gaming console 10000 games",
  ],
  "Outdoor Recreation": [
    "rei co-op flash hiking boots", "salomon x ultra 4 gtx hiking shoes",
    "osprey atmos ag 65 backpack", "gregory baltoro 65 backpack",
    "msr hubba hubba 2 person tent", "big agnes copper spur hv ul2",
    "jetboil flash camping stove", "msr pocketrocket deluxe stove",
    "black diamond spot 400 headlamp", "petzl actik core headlamp",
    "nemo tensor insulated sleeping pad", "thermarest neoair xlite pad",
    "kelty cosmic 20 sleeping bag", "sea to summit spark sleeping bag",
    "darn tough hiking socks merino wool", "smartwool phd outdoor socks",
    "hydrapak shape-shift water reservoir", "katadyn befree water filter",
    "garmin inreach mini 2 satellite", "spot x satellite messenger",
    "patagonia nano puff jacket", "arcteryx atom lt hoody",
    "black diamond trail trekking poles", "leki makalu fx carbon poles",
    "osprey ultralight stuff pack", "sea to summit dry bag 20l",
    "prana stretch zion pants men", "kuhl renegade hiking pants",
    "yeti tundra 35 hard cooler", "rtic ultralight 52 quart cooler",
    "paddleboard inflatable sup complete", "intex explorer k2 kayak",
    "trek marlin 7 mountain bike", "schwinn discover hybrid bike",
    "rock climbing harness black diamond", "mammut crag sender harness",
    "trekology ultralight camp chair", "helinox chair one",
    "sawyer squeeze water filter", "lifestraw personal water filter",
  ],
};

// ============================================================
// BACKUP & DB LOADING (shared across all modes)
// ============================================================

const BACKUP_DIR = path.join(__dirname, "..", "..", "data", "backup");

function ensureDirs() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function saveBackup(category: string, products: ScrapedProduct[]): number {
  ensureDirs();
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

function loadToDatabase(products: ScrapedProduct[], dryRun: boolean): { inserted: number; skipped: number } {
  if (dryRun) return { inserted: 0, skipped: products.length };

  try { db.exec("ALTER TABLE products ADD COLUMN scraped_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE products ADD COLUMN added_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE products ADD COLUMN verified INTEGER DEFAULT 0"); } catch {}

  const existingAsins = new Set<string>();
  const rows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of rows) existingAsins.add(r.asin);

  // The manufacturer column is added by migration v4 in db.ts.
  // No ALTER TABLE needed here — the column is guaranteed to exist.

  const insert = db.prepare(
    `INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active, scraped_at, added_at, verified, manufacturer)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?)`
  );

  const now = new Date().toISOString();
  let inserted = 0, skipped = 0;

  const tx = db.transaction((items: ScrapedProduct[]) => {
    for (const p of items) {
      if (existingAsins.has(p.asin)) { skipped++; continue; }
      existingAsins.add(p.asin);
      insert.run(p.asin, p.title, p.image_url, p.title, p.price_cents, p.category, p.scraped_at, now, p.manufacturer ?? null);
      inserted++;
    }
  });
  tx(products);
  db.pragma("wal_checkpoint(TRUNCATE)");

  return { inserted, skipped };
}

// ============================================================
// CAPTCHA HANDLER — shared across all modes
// ============================================================

async function handleCaptcha(captchaCount: number): Promise<number> {
  captchaCount++;
  if (captchaCount >= 3) {
    console.log("  Hit captcha wall — waiting 90s...");
    await sleep(90000);
    return 0;
  }
  await sleep(15000);
  return captchaCount;
}

// ============================================================
// MAIN PIPELINE
// ============================================================

async function runSearchMode(categories: string[], target: number, dryRun: boolean, globalSeenAsins: Set<string>) {
  let captchaCount = 0;

  const existingByCategory: Record<string, number> = {};
  const catCounts = db.prepare("SELECT category, COUNT(*) as c FROM products WHERE is_active = 1 GROUP BY category").all() as { category: string; c: number }[];
  for (const r of catCounts) existingByCategory[r.category] = r.c;

  for (const category of categories) {
    const existing = existingByCategory[category] || 0;
    const needed = target - existing;
    const queries = CATEGORY_SEARCHES[category] || [];

    if (needed <= 0) {
      console.log(`  [${category}] Already at ${existing} — skipping`);
      continue;
    }

    console.log(`\n  [${category}] Have ${existing}, need ${needed} (${queries.length} queries)`);
    const categoryProducts: ScrapedProduct[] = [];

    for (const query of queries) {
      if (categoryProducts.length >= needed) break;
      process.stdout.write(`    "${query}"... `);

      try {
        const html = fetchSearchPage(query);
        if (isCaptcha(html)) {
          console.log("CAPTCHA");
          captchaCount = await handleCaptcha(captchaCount);
          continue;
        }
        captchaCount = 0;

        const products = parseSearchResults(html, category);
        let added = 0;
        for (const p of products) {
          if (categoryProducts.length >= needed) break;
          if (!globalSeenAsins.has(p.asin)) {
            globalSeenAsins.add(p.asin);
            categoryProducts.push(p);
            added++;
          }
        }
        console.log(`${products.length} found, +${added} new (${existing + categoryProducts.length}/${target})`);
      } catch (err: any) {
        console.log(`ERROR: ${err.message?.slice(0, 60)}`);
      }

      await sleep(8000 + Math.random() * 7000);
    }

    // Verify & save
    await verifyAndSave(categoryProducts, category, dryRun);
  }
}

async function runAsinMode(asins: string[], category: string, dryRun: boolean, globalSeenAsins: Set<string>) {
  console.log(`\n  Scraping ${asins.length} ASINs for "${category}"...`);
  const products: ScrapedProduct[] = [];
  let captchaCount = 0;

  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    if (globalSeenAsins.has(asin)) {
      process.stdout.write(`    [${i + 1}/${asins.length}] ${asin}... SKIP (dupe)\n`);
      continue;
    }

    process.stdout.write(`    [${i + 1}/${asins.length}] ${asin}... `);
    const result = scrapeProductPage(asin, category);

    switch (result.status) {
      case "ok":
        globalSeenAsins.add(asin);
        products.push(result.product);
        console.log(`OK $${(result.product.price_cents / 100).toFixed(2)} "${result.product.title.slice(0, 55)}..."`);
        break;
      case "captcha":
        console.log("CAPTCHA");
        captchaCount = await handleCaptcha(captchaCount);
        i--; // retry
        break;
      case "not_found":
        console.log("404");
        break;
      case "no_data":
        console.log("NO DATA");
        break;
    }

    // 6-12s delay between individual page scrapes
    await sleep(6000 + Math.random() * 6000);
  }

  await verifyAndSave(products, category, dryRun);
}

async function runDiscoverMode(categories: string[], target: number, dryRun: boolean, globalSeenAsins: Set<string>) {
  for (const category of categories) {
    console.log(`\n  [${category}] Discovering ASINs from blogs...`);

    // Step 1: Find blog articles
    process.stdout.write("    Searching for articles... ");
    const blogUrls = searchForBlogs(category);
    console.log(`${blogUrls.length} URLs found`);

    if (blogUrls.length === 0) {
      console.log("    No articles found — skipping");
      continue;
    }

    // Step 2: Extract ASINs from articles
    const discoveredAsins: string[] = [];
    for (const url of blogUrls.slice(0, 8)) { // limit to 8 articles
      process.stdout.write(`    Extracting from ${url.slice(0, 70)}... `);
      await sleep(3000 + Math.random() * 3000);
      const asins = extractAsinsFromUrl(url);
      const newAsins = asins.filter((a) => !globalSeenAsins.has(a));
      discoveredAsins.push(...newAsins);
      console.log(`${asins.length} ASINs (${newAsins.length} new)`);

      if (discoveredAsins.length >= target) break;
    }

    const uniqueAsins = [...new Set(discoveredAsins)].slice(0, target);
    console.log(`    Total unique ASINs discovered: ${uniqueAsins.length}`);

    if (uniqueAsins.length === 0) continue;

    // Step 3: Scrape each ASIN
    await runAsinMode(uniqueAsins, category, dryRun, globalSeenAsins);
  }
}

async function verifyAndSave(products: ScrapedProduct[], category: string, dryRun: boolean) {
  if (products.length === 0) {
    console.log(`  [${category}] No products to verify`);
    return;
  }

  process.stdout.write(`  Verifying ${products.length} images... `);
  const verified: ScrapedProduct[] = [];
  for (const p of products) {
    if (await verifyImageUrl(p.image_url)) {
      verified.push(p);
    }
  }
  console.log(`${verified.length}/${products.length} passed`);

  if (verified.length > 0) {
    const backupTotal = saveBackup(category, verified);
    console.log(`  Backed up (${backupTotal} total in backup)`);

    const { inserted, skipped } = loadToDatabase(verified, dryRun);
    if (dryRun) {
      console.log(`  [DRY RUN] Would insert ${verified.length}`);
    } else {
      console.log(`  Loaded ${inserted} new, ${skipped} skipped`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = ["search", "asin", "discover"].includes(args[0]) ? args[0] : "search";
  const dryRun = args.includes("--dry-run");
  const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];
  const target = targetArg ? parseInt(targetArg) : 100;

  const categoryFilter = args.find((a) => a.startsWith("--category="))?.split("=")[1]
    || (args.indexOf("--category") >= 0 ? args[args.indexOf("--category") + 1] : null);

  const asinFile = args.find((a) => a.startsWith("--file="))?.split("=")[1]
    || (args.indexOf("--file") >= 0 ? args[args.indexOf("--file") + 1] : null);

  const asinList = args.find((a) => a.startsWith("--asins="))?.split("=")[1]
    || (args.indexOf("--asins") >= 0 ? args[args.indexOf("--asins") + 1] : null);

  ensureDirs();

  // Load existing ASINs
  const globalSeenAsins = new Set<string>();
  const existingRows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of existingRows) globalSeenAsins.add(r.asin);

  // Determine categories
  let categories = Object.keys(CATEGORY_SEARCHES);
  if (categoryFilter) {
    const match = categories.find((c) => c.toLowerCase() === categoryFilter.toLowerCase());
    if (!match) {
      console.error(`Unknown category: ${categoryFilter}`);
      console.error(`Available: ${categories.join(", ")}`);
      process.exit(1);
    }
    categories = [match];
  }

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║     AMAZON PRODUCT SCRAPING PIPELINE                ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log(`Mode:       ${mode.toUpperCase()}`);
  console.log(`Dry run:    ${dryRun}`);
  console.log(`Target:     ${target} per category`);
  console.log(`Existing:   ${existingRows.length} products in DB`);
  console.log(`Categories: ${categories.length}`);

  switch (mode) {
    case "search":
      await runSearchMode(categories, target, dryRun, globalSeenAsins);
      break;

    case "asin": {
      if (!categoryFilter) {
        console.error("\nASIN mode requires --category");
        process.exit(1);
      }
      let asins: string[] = [];
      if (asinFile) {
        const content = fs.readFileSync(asinFile, "utf-8");
        asins = content.split(/[\n,\s]+/).map((s) => s.trim()).filter((s) => /^[A-Z0-9]{10}$/.test(s));
      } else if (asinList) {
        asins = asinList.split(",").map((s) => s.trim()).filter((s) => /^[A-Z0-9]{10}$/.test(s));
      } else {
        console.error("\nASIN mode requires --file or --asins");
        process.exit(1);
      }
      console.log(`ASINs:      ${asins.length}`);
      await runAsinMode(asins, categoryFilter, dryRun, globalSeenAsins);
      break;
    }

    case "discover":
      await runDiscoverMode(categories, target, dryRun, globalSeenAsins);
      break;
  }

  // Final summary
  const finalTotal = (db.prepare("SELECT COUNT(*) as c FROM products").get() as { c: number }).c;
  const finalCats = db.prepare("SELECT category, COUNT(*) as c FROM products WHERE is_active = 1 GROUP BY category ORDER BY c DESC").all() as { category: string; c: number }[];

  console.log("\n══════════════════════════════════════════════════");
  console.log("PIPELINE COMPLETE");
  console.log("══════════════════════════════════════════════════");
  console.log(`Database: ${finalTotal} products`);
  for (const r of finalCats) console.log(`  ${r.category}: ${r.c}`);
  console.log(`\nBackups: ${BACKUP_DIR}`);
}

main().catch(console.error);
