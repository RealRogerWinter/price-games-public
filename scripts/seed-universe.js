/**
 * Seed script for Product Universe.
 *
 * Uses Claude Code as the "AI" to generate realistic enrichment data
 * for 100 random products. Populates all PU tables with materials,
 * companies, locations, supply chain nodes, summaries, similarity
 * scores, and galaxy positions.
 *
 * Run: node scripts/seed-universe.js
 */

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.resolve(__dirname, "../apps/server/data/price-game.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const NOW = new Date().toISOString();

// ─── Material library by category ───────────────────────────────────────────

const MATERIAL_DB = {
  metals: [
    { name: "Stainless Steel (304)", category: "metal", desc: "Austenitic chromium-nickel stainless steel, corrosion resistant", sustainability: 0.6 },
    { name: "Aluminum Alloy (6061)", category: "metal", desc: "Lightweight aluminum alloy with good mechanical properties", sustainability: 0.7 },
    { name: "Carbon Steel", category: "metal", desc: "Iron-carbon alloy used in structural applications", sustainability: 0.5 },
    { name: "Copper", category: "metal", desc: "Highly conductive metal used in electrical wiring", sustainability: 0.6 },
    { name: "Zinc Alloy", category: "metal", desc: "Die-cast alloy used in hardware and decorative parts", sustainability: 0.5 },
    { name: "Titanium", category: "metal", desc: "Lightweight, high-strength metal with excellent corrosion resistance", sustainability: 0.4 },
    { name: "Brass", category: "metal", desc: "Copper-zinc alloy with good machinability", sustainability: 0.6 },
    { name: "Cast Iron", category: "metal", desc: "Iron alloy with high carbon content, excellent heat retention", sustainability: 0.7 },
  ],
  plastics: [
    { name: "ABS (Acrylonitrile Butadiene Styrene)", category: "plastic", desc: "Impact-resistant thermoplastic polymer", sustainability: 0.3 },
    { name: "Polypropylene (PP)", category: "plastic", desc: "Lightweight, chemical-resistant thermoplastic", sustainability: 0.4 },
    { name: "Polycarbonate (PC)", category: "plastic", desc: "Transparent, high-impact-strength thermoplastic", sustainability: 0.3 },
    { name: "Nylon (PA6)", category: "plastic", desc: "Wear-resistant engineering thermoplastic", sustainability: 0.3 },
    { name: "HDPE (High-Density Polyethylene)", category: "plastic", desc: "Versatile, recyclable polyethylene", sustainability: 0.5 },
    { name: "Silicone Rubber", category: "plastic", desc: "Flexible, heat-resistant synthetic rubber", sustainability: 0.4 },
    { name: "PVC (Polyvinyl Chloride)", category: "plastic", desc: "Durable, widely used thermoplastic", sustainability: 0.2 },
    { name: "TPU (Thermoplastic Polyurethane)", category: "plastic", desc: "Flexible, abrasion-resistant elastomer", sustainability: 0.3 },
  ],
  textiles: [
    { name: "Cotton (Organic)", category: "textile", desc: "Natural cellulose fiber grown without synthetic pesticides", sustainability: 0.8 },
    { name: "Polyester", category: "textile", desc: "Synthetic PET-based textile fiber", sustainability: 0.3 },
    { name: "Nylon Fabric", category: "textile", desc: "Durable synthetic fabric with high tensile strength", sustainability: 0.3 },
    { name: "Leather (Genuine)", category: "textile", desc: "Tanned animal hide used in fashion and accessories", sustainability: 0.4 },
    { name: "Spandex (Elastane)", category: "textile", desc: "Highly elastic synthetic fiber", sustainability: 0.3 },
    { name: "Wool (Merino)", category: "textile", desc: "Fine natural fiber from merino sheep", sustainability: 0.7 },
    { name: "Canvas", category: "textile", desc: "Heavy-duty plain-woven fabric", sustainability: 0.6 },
    { name: "Microfiber", category: "textile", desc: "Ultrafine synthetic fiber blend", sustainability: 0.3 },
  ],
  electronics: [
    { name: "FR-4 PCB Substrate", category: "electronic", desc: "Flame-retardant fiberglass-epoxy laminate for circuit boards", sustainability: 0.2 },
    { name: "Lithium-Ion Battery Cells", category: "electronic", desc: "Rechargeable lithium cobalt oxide cells", sustainability: 0.2 },
    { name: "LCD Display Panel", category: "electronic", desc: "Liquid crystal display with LED backlight", sustainability: 0.3 },
    { name: "Silicon Semiconductor", category: "electronic", desc: "Integrated circuit chips on silicon wafers", sustainability: 0.3 },
    { name: "Copper Wire (Enameled)", category: "electronic", desc: "Insulated copper conductor for motors and transformers", sustainability: 0.5 },
    { name: "Rare Earth Magnets (NdFeB)", category: "electronic", desc: "Neodymium-iron-boron permanent magnets", sustainability: 0.2 },
  ],
  wood: [
    { name: "MDF (Medium-Density Fiberboard)", category: "wood", desc: "Engineered wood composite from wood fibers", sustainability: 0.5 },
    { name: "Bamboo", category: "wood", desc: "Fast-growing grass used as sustainable wood alternative", sustainability: 0.9 },
    { name: "Pine (Solid)", category: "wood", desc: "Softwood lumber from pine trees", sustainability: 0.7 },
    { name: "Plywood (Birch)", category: "wood", desc: "Laminated wood veneer sheets", sustainability: 0.6 },
    { name: "Oak (Hardwood)", category: "wood", desc: "Dense hardwood used in furniture and flooring", sustainability: 0.6 },
  ],
  glass: [
    { name: "Borosilicate Glass", category: "glass", desc: "Heat-resistant glass with low thermal expansion", sustainability: 0.7 },
    { name: "Tempered Glass", category: "glass", desc: "Safety glass with increased strength", sustainability: 0.6 },
    { name: "Soda-Lime Glass", category: "glass", desc: "Common glass used in bottles and windows", sustainability: 0.7 },
  ],
  natural: [
    { name: "Natural Rubber (Latex)", category: "natural", desc: "Elastic polymer from rubber tree sap", sustainability: 0.7 },
    { name: "Beeswax", category: "natural", desc: "Natural wax produced by honey bees", sustainability: 0.8 },
    { name: "Cork", category: "natural", desc: "Bark of the cork oak tree, renewable and biodegradable", sustainability: 0.9 },
    { name: "Ceramic", category: "natural", desc: "Fired clay or porcelain material", sustainability: 0.7 },
  ],
  chemical: [
    { name: "Glycerin", category: "chemical", desc: "Humectant used in skincare and food products", sustainability: 0.6 },
    { name: "Titanium Dioxide", category: "chemical", desc: "White pigment used in paints, sunscreens, and food", sustainability: 0.4 },
    { name: "Sodium Lauryl Sulfate", category: "chemical", desc: "Surfactant used in cleaning and personal care products", sustainability: 0.3 },
    { name: "Hyaluronic Acid", category: "chemical", desc: "Moisturizing polysaccharide used in skincare", sustainability: 0.5 },
    { name: "Retinol (Vitamin A)", category: "chemical", desc: "Fat-soluble vitamin used in anti-aging skincare", sustainability: 0.5 },
  ],
};

// ─── Category → material mapping ────────────────────────────────────────────

const CATEGORY_MATERIALS = {
  Kitchen: ["metals", "plastics", "glass", "natural"],
  Appliances: ["metals", "plastics", "electronics", "glass"],
  Electronics: ["metals", "plastics", "electronics"],
  "Phone & Tablet Accessories": ["plastics", "electronics", "textiles"],
  Gaming: ["plastics", "electronics", "metals"],
  Fashion: ["textiles", "metals", "natural"],
  Jewelry: ["metals", "glass", "natural"],
  Beauty: ["chemical", "plastics", "glass"],
  "Health & Wellness": ["chemical", "plastics", "natural"],
  Furniture: ["wood", "metals", "textiles"],
  "Home Decor": ["wood", "glass", "textiles", "natural"],
  "Tools & Home Improvement": ["metals", "plastics", "electronics"],
  "Garden & Outdoor": ["metals", "plastics", "wood"],
  "Outdoor Recreation": ["textiles", "metals", "plastics"],
  "Sports & Fitness": ["textiles", "plastics", "metals"],
  Automotive: ["metals", "plastics", "electronics"],
  "Cleaning & Household": ["chemical", "plastics", "textiles"],
  Foods: ["natural", "plastics", "chemical"],
  Baby: ["textiles", "plastics", "natural"],
  Pet: ["textiles", "plastics", "metals"],
  Toys: ["plastics", "textiles", "electronics"],
  Music: ["wood", "metals", "electronics"],
  "Arts & Crafts": ["wood", "natural", "chemical", "textiles"],
  "Office & School Supplies": ["plastics", "wood", "metals"],
  "Travel & Luggage": ["textiles", "plastics", "metals"],
  Costumes: ["textiles", "plastics"],
  Collectibles: ["plastics", "metals", "glass"],
  Figurines: ["plastics", "natural", "metals"],
  "Weird and Wonderful": ["plastics", "metals", "textiles", "natural"],
};

// ─── Company library ────────────────────────────────────────────────────────

const COMPANIES = [
  { name: "Instant Brands", desc: "Parent company of Instant Pot and other kitchen brands", website: "https://instantbrands.com", founded: 2013, hq: "Downers Grove, Illinois, USA", employees: 1200, revenue: "$800M" },
  { name: "KitchenAid", desc: "Premium kitchen appliance manufacturer owned by Whirlpool", website: "https://kitchenaid.com", founded: 1919, hq: "Benton Harbor, Michigan, USA", employees: 3000, revenue: "$2.5B" },
  { name: "Samsung Electronics", desc: "South Korean multinational electronics conglomerate", website: "https://samsung.com", founded: 1969, hq: "Suwon, South Korea", employees: 267937, revenue: "$200B" },
  { name: "Anker Innovations", desc: "Consumer electronics company specializing in charging technology", website: "https://anker.com", founded: 2011, hq: "Shenzhen, China", employees: 3500, revenue: "$1.8B" },
  { name: "DeWalt (Stanley Black & Decker)", desc: "Professional-grade power tools manufacturer", website: "https://dewalt.com", founded: 1923, hq: "Towson, Maryland, USA", employees: 5000, revenue: "$4B" },
  { name: "Nike", desc: "World's largest athletic apparel and footwear company", website: "https://nike.com", founded: 1964, hq: "Beaverton, Oregon, USA", employees: 79400, revenue: "$51B" },
  { name: "L'Oréal", desc: "World's largest cosmetics and beauty company", website: "https://loreal.com", founded: 1909, hq: "Clichy, France", employees: 85400, revenue: "$41B" },
  { name: "Procter & Gamble", desc: "Multinational consumer goods corporation", website: "https://pg.com", founded: 1837, hq: "Cincinnati, Ohio, USA", employees: 101000, revenue: "$80B" },
  { name: "Hasbro", desc: "Entertainment and toy company", website: "https://hasbro.com", founded: 1923, hq: "Pawtucket, Rhode Island, USA", employees: 6600, revenue: "$5.9B" },
  { name: "IKEA (Ingka Group)", desc: "Swedish multinational furniture and home goods retailer", website: "https://ikea.com", founded: 1943, hq: "Leiden, Netherlands", employees: 231000, revenue: "$47B" },
  { name: "3M Company", desc: "Multinational conglomerate producing adhesives, abrasives, and laminates", website: "https://3m.com", founded: 1902, hq: "Saint Paul, Minnesota, USA", employees: 92000, revenue: "$35B" },
  { name: "Foxconn (Hon Hai)", desc: "World's largest contract electronics manufacturer", website: "https://foxconn.com", founded: 1974, hq: "New Taipei City, Taiwan", employees: 878000, revenue: "$215B" },
  { name: "Flex Ltd.", desc: "Global supply chain and manufacturing solutions provider", website: "https://flex.com", founded: 1969, hq: "Singapore", employees: 160000, revenue: "$26B" },
  { name: "Jabil Inc.", desc: "Contract manufacturing and product management services", website: "https://jabil.com", founded: 1966, hq: "St. Petersburg, Florida, USA", employees: 260000, revenue: "$35B" },
  { name: "BASF SE", desc: "World's largest chemical producer", website: "https://basf.com", founded: 1865, hq: "Ludwigshafen, Germany", employees: 111000, revenue: "$87B" },
  { name: "Dow Chemical", desc: "Global materials science company", website: "https://dow.com", founded: 1897, hq: "Midland, Michigan, USA", employees: 36500, revenue: "$57B" },
  { name: "Corning Inc.", desc: "Glass and ceramics manufacturer specializing in specialty materials", website: "https://corning.com", founded: 1851, hq: "Corning, New York, USA", employees: 61000, revenue: "$14B" },
  { name: "Yue Yuen Industrial", desc: "World's largest branded athletic footwear manufacturer", website: "https://yueyuen.com", founded: 1988, hq: "Hong Kong", employees: 330000, revenue: "$9B" },
  { name: "Li & Fung", desc: "Global supply chain manager for consumer goods", website: "https://lifung.com", founded: 1906, hq: "Hong Kong", employees: 17000, revenue: "$12B" },
  { name: "Shenzhen Sunway Communication", desc: "Electronic components and antenna manufacturer", website: "https://sunway.com.cn", founded: 2005, hq: "Shenzhen, China", employees: 5000, revenue: "$600M" },
  { name: "Nippon Steel", desc: "Japan's largest steel producer", website: "https://nipponsteel.com", founded: 1970, hq: "Tokyo, Japan", employees: 106000, revenue: "$52B" },
  { name: "POSCO", desc: "South Korean multinational steel-making company", website: "https://posco.com", founded: 1968, hq: "Pohang, South Korea", employees: 50000, revenue: "$65B" },
  { name: "Unilever", desc: "British-Dutch multinational consumer goods company", website: "https://unilever.com", founded: 1929, hq: "London, UK", employees: 148000, revenue: "$60B" },
  { name: "Mattel", desc: "Global toy manufacturing company", website: "https://mattel.com", founded: 1945, hq: "El Segundo, California, USA", employees: 33000, revenue: "$5.4B" },
  { name: "Weber-Stephen Products", desc: "Manufacturer of charcoal, gas, and electric outdoor grills", website: "https://weber.com", founded: 1952, hq: "Palatine, Illinois, USA", employees: 3500, revenue: "$1.7B" },
];

// ─── Manufacturing locations ────────────────────────────────────────────────

const LOCATIONS = [
  { name: "Shenzhen Manufacturing Hub", country: "China", region: "Guangdong", lat: 22.5431, lng: 114.0579, type: "manufacturing" },
  { name: "Dongguan Factory District", country: "China", region: "Guangdong", lat: 23.0489, lng: 113.7433, type: "manufacturing" },
  { name: "Shanghai Electronics Zone", country: "China", region: "Shanghai", lat: 31.2304, lng: 121.4737, type: "manufacturing" },
  { name: "Zhengzhou Industrial Park", country: "China", region: "Henan", lat: 34.7466, lng: 113.6253, type: "manufacturing" },
  { name: "Suzhou Industrial Park", country: "China", region: "Jiangsu", lat: 31.2989, lng: 120.5853, type: "manufacturing" },
  { name: "Ho Chi Minh City Factory", country: "Vietnam", region: "Southern Vietnam", lat: 10.8231, lng: 106.6297, type: "manufacturing" },
  { name: "Binh Duong Industrial Zone", country: "Vietnam", region: "Southern Vietnam", lat: 11.1671, lng: 106.6500, type: "manufacturing" },
  { name: "Monterrey Manufacturing", country: "Mexico", region: "Nuevo León", lat: 25.6866, lng: -100.3161, type: "manufacturing" },
  { name: "Guadalajara Electronics", country: "Mexico", region: "Jalisco", lat: 20.6597, lng: -103.3496, type: "manufacturing" },
  { name: "Pohang Steel Works", country: "South Korea", region: "North Gyeongsang", lat: 36.0190, lng: 129.3435, type: "raw_material" },
  { name: "Chennai Electronics Hub", country: "India", region: "Tamil Nadu", lat: 13.0827, lng: 80.2707, type: "manufacturing" },
  { name: "Bangalore Tech Park", country: "India", region: "Karnataka", lat: 12.9716, lng: 77.5946, type: "manufacturing" },
  { name: "Memphis Distribution Center", country: "USA", region: "Tennessee", lat: 35.1495, lng: -90.0490, type: "distribution" },
  { name: "Louisville Logistics Hub", country: "USA", region: "Kentucky", lat: 38.2527, lng: -85.7585, type: "distribution" },
  { name: "Ontario, CA Fulfillment", country: "USA", region: "California", lat: 34.0633, lng: -117.6509, type: "distribution" },
  { name: "Edison NJ Warehouse", country: "USA", region: "New Jersey", lat: 40.5187, lng: -74.4121, type: "distribution" },
  { name: "Rotterdam Port", country: "Netherlands", region: "South Holland", lat: 51.9225, lng: 4.4792, type: "distribution" },
  { name: "Port of Long Beach", country: "USA", region: "California", lat: 33.7523, lng: -118.1912, type: "distribution" },
  { name: "Ludwigshafen Chemical Plant", country: "Germany", region: "Rhineland-Palatinate", lat: 49.4774, lng: 8.4452, type: "raw_material" },
  { name: "Midland Chemical Complex", country: "USA", region: "Michigan", lat: 43.6156, lng: -84.2472, type: "raw_material" },
  { name: "Corning Glass Works", country: "USA", region: "New York", lat: 42.1428, lng: -77.0547, type: "raw_material" },
  { name: "Para Rubber Plantation", country: "Brazil", region: "Pará", lat: -1.4558, lng: -48.5024, type: "raw_material" },
  { name: "Côte d'Ivoire Cocoa Region", country: "Ivory Coast", region: "Bas-Sassandra", lat: 5.3599, lng: -4.0083, type: "raw_material" },
  { name: "Atacama Lithium Fields", country: "Chile", region: "Antofagasta", lat: -23.6345, lng: -68.2094, type: "raw_material" },
  { name: "Congo Cobalt Mines", country: "DR Congo", region: "Katanga", lat: -10.9831, lng: 26.0220, type: "raw_material" },
  { name: "Australian Iron Ore (Pilbara)", country: "Australia", region: "Western Australia", lat: -22.3285, lng: 118.5861, type: "raw_material" },
  { name: "Almería Greenhouse District", country: "Spain", region: "Andalusia", lat: 36.8340, lng: -2.4637, type: "raw_material" },
  { name: "Bangladesh Garment District", country: "Bangladesh", region: "Dhaka", lat: 23.8103, lng: 90.4125, type: "manufacturing" },
  { name: "Lesquin Distribution (Europe)", country: "France", region: "Hauts-de-France", lat: 50.5833, lng: 3.1167, type: "distribution" },
  { name: "Tokyo Component Hub", country: "Japan", region: "Tokyo", lat: 35.6762, lng: 139.6503, type: "manufacturing" },
];

// ─── Category → company role mapping ────────────────────────────────────────

const CATEGORY_BRAND_MAP = {
  Kitchen: [0, 1], // Instant Brands, KitchenAid
  Appliances: [0, 1, 2],
  Electronics: [2, 3], // Samsung, Anker
  "Phone & Tablet Accessories": [3, 19],
  Gaming: [2, 3],
  Fashion: [5, 17, 18],
  Jewelry: [18],
  Beauty: [6, 7, 22],
  "Health & Wellness": [7, 22],
  Furniture: [9, 10],
  "Home Decor": [9],
  "Tools & Home Improvement": [4, 10],
  "Garden & Outdoor": [24, 4],
  "Outdoor Recreation": [5],
  "Sports & Fitness": [5],
  Automotive: [10, 15],
  "Cleaning & Household": [7, 22],
  Foods: [22, 7],
  Baby: [7, 22],
  Pet: [7],
  Toys: [8, 23],
  Music: [9],
  "Arts & Crafts": [10],
  "Office & School Supplies": [10],
  "Travel & Luggage": [18],
  Costumes: [8, 23],
  Collectibles: [8, 23],
  Figurines: [8, 23],
  "Weird and Wonderful": [8, 23],
};

// ─── Supply chain templates by product type ─────────────────────────────────

const SUPPLY_CHAIN_TEMPLATES = {
  electronics: [
    { nodeType: "raw_material", locIndices: [23, 24, 25], desc: "Raw material extraction (lithium, cobalt, rare earths)" },
    { nodeType: "processing", locIndices: [9, 19], desc: "Metal refining and semiconductor fabrication" },
    { nodeType: "manufacturing", locIndices: [0, 1, 2, 3], desc: "Component manufacturing and PCB assembly" },
    { nodeType: "assembly", locIndices: [0, 3, 4], desc: "Final product assembly and quality testing" },
    { nodeType: "distribution", locIndices: [17, 12, 13], desc: "Shipping via ocean freight to regional distribution centers" },
    { nodeType: "retail", locIndices: [14, 15], desc: "Fulfillment and last-mile delivery to consumers" },
  ],
  textile: [
    { nodeType: "raw_material", locIndices: [21, 22], desc: "Natural fiber cultivation or synthetic polymer production" },
    { nodeType: "processing", locIndices: [27, 6], desc: "Yarn spinning, dyeing, and fabric weaving" },
    { nodeType: "manufacturing", locIndices: [27, 5, 6], desc: "Cut-and-sew garment manufacturing" },
    { nodeType: "distribution", locIndices: [16, 12, 13], desc: "International shipping and regional warehousing" },
    { nodeType: "retail", locIndices: [14, 15], desc: "Consumer fulfillment" },
  ],
  kitchen: [
    { nodeType: "raw_material", locIndices: [25, 9], desc: "Steel production and alloy preparation" },
    { nodeType: "processing", locIndices: [18, 19], desc: "Metal forming, stamping, and surface treatment" },
    { nodeType: "manufacturing", locIndices: [0, 1, 4], desc: "Product assembly and electrical component integration" },
    { nodeType: "assembly", locIndices: [0, 2], desc: "Final assembly, packaging, and quality control" },
    { nodeType: "distribution", locIndices: [17, 12], desc: "Ocean and ground freight to distribution centers" },
    { nodeType: "retail", locIndices: [14, 15], desc: "Warehouse fulfillment to end consumers" },
  ],
  furniture: [
    { nodeType: "raw_material", locIndices: [25], desc: "Timber harvesting or engineered wood production" },
    { nodeType: "processing", locIndices: [0, 1], desc: "Lumber milling, veneer production, hardware fabrication" },
    { nodeType: "manufacturing", locIndices: [0, 5, 7], desc: "Furniture construction and upholstery" },
    { nodeType: "distribution", locIndices: [17, 12, 16], desc: "Flat-pack shipping to regional distribution" },
    { nodeType: "retail", locIndices: [14, 15], desc: "Consumer delivery and assembly" },
  ],
  beauty: [
    { nodeType: "raw_material", locIndices: [18, 19, 21], desc: "Chemical ingredient sourcing and botanical extraction" },
    { nodeType: "processing", locIndices: [18, 19], desc: "Active ingredient synthesis and formulation" },
    { nodeType: "manufacturing", locIndices: [28, 5, 0], desc: "Product blending, filling, and packaging" },
    { nodeType: "distribution", locIndices: [16, 12], desc: "Temperature-controlled shipping to distribution centers" },
    { nodeType: "retail", locIndices: [14, 15], desc: "Fulfillment to retail and direct-to-consumer" },
  ],
  general: [
    { nodeType: "raw_material", locIndices: [25, 9, 18], desc: "Raw material sourcing" },
    { nodeType: "manufacturing", locIndices: [0, 1, 5, 7], desc: "Product manufacturing" },
    { nodeType: "distribution", locIndices: [17, 12, 13], desc: "Global distribution" },
    { nodeType: "retail", locIndices: [14, 15], desc: "Consumer fulfillment" },
  ],
};

const CATEGORY_CHAIN_TYPE = {
  Kitchen: "kitchen", Appliances: "kitchen",
  Electronics: "electronics", "Phone & Tablet Accessories": "electronics",
  Gaming: "electronics", Music: "electronics",
  Fashion: "textile", Costumes: "textile", "Sports & Fitness": "textile",
  "Outdoor Recreation": "textile", "Travel & Luggage": "textile",
  Furniture: "furniture", "Home Decor": "furniture",
  Beauty: "beauty", "Health & Wellness": "beauty", "Cleaning & Household": "beauty",
  Jewelry: "general", "Tools & Home Improvement": "general",
  "Garden & Outdoor": "general", Automotive: "general",
  Foods: "general", Baby: "general", Pet: "general",
  Toys: "general", "Arts & Crafts": "general",
  "Office & School Supplies": "general", Collectibles: "general",
  Figurines: "general", "Weird and Wonderful": "general",
};

// ─── Summary card templates ─────────────────────────────────────────────────

function generateSummary(product) {
  const cat = product.category || "Consumer Goods";
  const price = (product.price_cents / 100).toFixed(2);
  return `A ${cat.toLowerCase()} product retailing at $${price}. ${product.title.substring(0, 120)}.`;
}

function generateHistory(product) {
  const cat = product.category || "consumer goods";
  const histories = [
    `Products in the ${cat.toLowerCase()} category have evolved significantly over the past decade, driven by advances in materials science and manufacturing automation. Modern supply chains for these items typically span 3-5 countries.`,
    `The ${cat.toLowerCase()} market has seen consolidation among manufacturers, with production increasingly concentrated in Southeast Asia. Quality improvements have been enabled by better quality control systems and material sourcing.`,
    `This type of ${cat.toLowerCase()} product represents a mature manufacturing category with well-established global supply chains. Recent trends include sustainability certifications and reshoring initiatives.`,
  ];
  return histories[product.id % histories.length];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}
function randBetween(a, b) { return a + Math.random() * (b - a); }

// ─── Main seed function ─────────────────────────────────────────────────────

function seed() {
  console.log("Starting Product Universe seeding...\n");

  // Get 100 random products
  const products = db.prepare(
    "SELECT id, title, category, price_cents, manufacturer FROM products ORDER BY RANDOM() LIMIT 100"
  ).all();
  console.log(`Selected ${products.length} products for enrichment`);

  // Insert sources
  const insertSource = db.prepare(
    "INSERT INTO pu_sources (url, title, fetched_at, content_hash) VALUES (?, ?, ?, ?)"
  );
  const sourceId = insertSource.run(
    "https://claude.ai/enrichment", "Claude Code AI Enrichment", NOW, "seed-" + Date.now()
  ).lastInsertRowid;
  console.log(`Created source record (id=${sourceId})`);

  // Insert all materials from the library
  const insertMaterial = db.prepare(
    "INSERT OR IGNORE INTO pu_materials (name, category, description, sustainability_score, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const materialMap = new Map(); // name -> id

  const insertMaterialTx = db.transaction(() => {
    for (const group of Object.values(MATERIAL_DB)) {
      for (const mat of group) {
        const result = insertMaterial.run(mat.name, mat.category, mat.desc, mat.sustainability, NOW);
        if (result.lastInsertRowid) {
          materialMap.set(mat.name, Number(result.lastInsertRowid));
        }
      }
    }
  });
  insertMaterialTx();

  // Also retrieve any existing material IDs
  const existingMats = db.prepare("SELECT id, name FROM pu_materials").all();
  for (const m of existingMats) materialMap.set(m.name, m.id);
  console.log(`Loaded ${materialMap.size} materials`);

  // Insert all companies
  const insertCompany = db.prepare(
    "INSERT OR IGNORE INTO pu_companies (name, description, website, founded_year, headquarters, employee_count, revenue, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const companyMap = new Map(); // name -> id

  const insertCompaniesTx = db.transaction(() => {
    for (const co of COMPANIES) {
      const result = insertCompany.run(co.name, co.desc, co.website, co.founded, co.hq, co.employees, co.revenue, NOW, NOW);
      if (result.lastInsertRowid) {
        companyMap.set(co.name, Number(result.lastInsertRowid));
      }
    }
  });
  insertCompaniesTx();

  const existingCos = db.prepare("SELECT id, name FROM pu_companies").all();
  for (const c of existingCos) companyMap.set(c.name, c.id);
  console.log(`Loaded ${companyMap.size} companies`);

  // Insert all locations
  const insertLocation = db.prepare(
    "INSERT OR IGNORE INTO pu_locations (name, country, region, latitude, longitude, location_type) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const locationMap = new Map(); // name -> id

  const insertLocationsTx = db.transaction(() => {
    for (const loc of LOCATIONS) {
      const result = insertLocation.run(loc.name, loc.country, loc.region, loc.lat, loc.lng, loc.type);
      if (result.lastInsertRowid) {
        locationMap.set(loc.name, Number(result.lastInsertRowid));
      }
    }
  });
  insertLocationsTx();

  const existingLocs = db.prepare("SELECT id, name FROM pu_locations").all();
  for (const l of existingLocs) locationMap.set(l.name, l.id);
  console.log(`Loaded ${locationMap.size} locations`);

  // Insert company relationships (supplier/partner links)
  const insertRelationship = db.prepare(
    "INSERT OR IGNORE INTO pu_company_relationships (company_id, related_company_id, relationship_type, confidence, source_id) VALUES (?, ?, ?, ?, ?)"
  );

  const insertRelsTx = db.transaction(() => {
    const coIds = [...companyMap.values()];
    // Contract manufacturers supply to brand companies
    const contractMfgs = [11, 12, 13]; // Foxconn, Flex, Jabil indices
    const brands = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; // brand company indices
    for (const mfgIdx of contractMfgs) {
      const mfgName = COMPANIES[mfgIdx].name;
      const mfgId = companyMap.get(mfgName);
      for (const brandIdx of pickN(brands, 3)) {
        const brandName = COMPANIES[brandIdx].name;
        const brandId = companyMap.get(brandName);
        if (mfgId && brandId) {
          insertRelationship.run(brandId, mfgId, "supplier", "high", sourceId);
        }
      }
    }
    // Chemical suppliers
    const chemIdx = [14, 15]; // BASF, Dow
    for (const ci of chemIdx) {
      const chemName = COMPANIES[ci].name;
      const chemId = companyMap.get(chemName);
      for (const brandIdx of pickN(brands, 4)) {
        const brandName = COMPANIES[brandIdx].name;
        const brandId = companyMap.get(brandName);
        if (chemId && brandId) {
          insertRelationship.run(brandId, chemId, "supplier", "medium", sourceId);
        }
      }
    }
  });
  insertRelsTx();
  console.log("Created company relationships");

  // ─── Enrich each product ────────────────────────────────────────────────

  const insertProductMaterial = db.prepare(
    "INSERT OR IGNORE INTO pu_product_materials (product_id, material_id, percentage, confidence, source_id) VALUES (?, ?, ?, ?, ?)"
  );
  const insertProductCompany = db.prepare(
    "INSERT OR IGNORE INTO pu_product_companies (product_id, company_id, role, confidence, source_id) VALUES (?, ?, ?, ?, ?)"
  );
  const insertSupplyNode = db.prepare(
    "INSERT INTO pu_supply_chain_nodes (product_id, node_type, company_id, location_id, description, order_index, confidence, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertMaterialLocation = db.prepare(
    "INSERT OR IGNORE INTO pu_material_locations (material_id, location_id, role, confidence, source_id) VALUES (?, ?, ?, ?, ?)"
  );
  const updateProduct = db.prepare(
    "UPDATE products SET pu_enriched = 1, pu_enriched_at = ?, pu_summary = ?, pu_history = ? WHERE id = ?"
  );

  const enrichTx = db.transaction(() => {
    for (const product of products) {
      const cat = product.category || "Weird and Wonderful";

      // 1. Assign materials
      const matGroups = CATEGORY_MATERIALS[cat] || CATEGORY_MATERIALS["Weird and Wonderful"];
      let remainingPct = 100;
      const numMaterials = 2 + Math.floor(Math.random() * 4); // 2-5 materials
      const selectedMaterials = [];

      for (let i = 0; i < numMaterials; i++) {
        const group = matGroups[i % matGroups.length];
        const mats = MATERIAL_DB[group];
        const mat = pick(mats);
        if (selectedMaterials.includes(mat.name)) continue;
        selectedMaterials.push(mat.name);

        const isLast = i === numMaterials - 1;
        const pct = isLast ? remainingPct : Math.max(5, Math.floor(remainingPct * randBetween(0.2, 0.6)));
        remainingPct -= pct;
        if (remainingPct < 5 && !isLast) remainingPct = 5;

        const matId = materialMap.get(mat.name);
        if (matId) {
          insertProductMaterial.run(product.id, matId, pct, pick(["high", "medium"]), sourceId);
        }
      }

      // 2. Assign companies (brand + manufacturer + supplier)
      const brandIndices = CATEGORY_BRAND_MAP[cat] || [8, 23];
      const brandIdx = pick(brandIndices);
      const brandId = companyMap.get(COMPANIES[brandIdx].name);
      if (brandId) {
        insertProductCompany.run(product.id, brandId, "brand_owner", "medium", sourceId);
      }

      // Contract manufacturer
      const mfgIdx = pick([11, 12, 13]);
      const mfgId = companyMap.get(COMPANIES[mfgIdx].name);
      if (mfgId) {
        insertProductCompany.run(product.id, mfgId, "manufacturer", "medium", sourceId);
      }

      // Material supplier
      const supplierIdx = pick([14, 15, 16, 20, 21]);
      const supplierId = companyMap.get(COMPANIES[supplierIdx].name);
      if (supplierId) {
        insertProductCompany.run(product.id, supplierId, "supplier", "low", sourceId);
      }

      // 3. Build supply chain
      const chainType = CATEGORY_CHAIN_TYPE[cat] || "general";
      const template = SUPPLY_CHAIN_TEMPLATES[chainType];
      let orderIdx = 0;

      for (const step of template) {
        const locIdx = pick(step.locIndices);
        const loc = LOCATIONS[locIdx];
        const locId = locationMap.get(loc.name);

        // Pick a company for this step
        let stepCompanyId = null;
        if (step.nodeType === "raw_material") stepCompanyId = supplierId;
        else if (step.nodeType === "manufacturing" || step.nodeType === "assembly") stepCompanyId = mfgId;
        else if (step.nodeType === "retail") stepCompanyId = brandId;

        insertSupplyNode.run(
          product.id, step.nodeType, stepCompanyId, locId,
          step.desc, orderIdx++, pick(["high", "medium", "low"]), sourceId
        );
      }

      // 4. Material-location links
      for (const matName of selectedMaterials) {
        const matId = materialMap.get(matName);
        if (!matId) continue;
        const rawLocs = LOCATIONS.filter(l => l.type === "raw_material");
        const loc = pick(rawLocs);
        const locId = locationMap.get(loc.name);
        if (locId) {
          insertMaterialLocation.run(matId, locId, "source", pick(["high", "medium"]), sourceId);
        }
      }

      // 5. Update product with summary
      updateProduct.run(NOW, generateSummary(product), generateHistory(product), product.id);
    }
  });
  enrichTx();
  console.log(`Enriched ${products.length} products with materials, companies, and supply chains`);

  // ─── Compute similarity scores ──────────────────────────────────────────

  const insertSimilarity = db.prepare(
    "INSERT OR IGNORE INTO pu_product_similarity (product_id_a, product_id_b, score, reason) VALUES (?, ?, ?, ?)"
  );

  const similarityTx = db.transaction(() => {
    // Group products by category for similarity
    const byCat = {};
    for (const p of products) {
      const cat = p.category || "Other";
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(p);
    }

    let simCount = 0;
    for (const [cat, catProducts] of Object.entries(byCat)) {
      // Same category = high similarity
      for (let i = 0; i < catProducts.length; i++) {
        for (let j = i + 1; j < catProducts.length; j++) {
          const score = randBetween(0.6, 0.95);
          insertSimilarity.run(
            catProducts[i].id, catProducts[j].id,
            Math.round(score * 1000) / 1000,
            `Both in ${cat} category with similar materials and supply chain`
          );
          simCount++;
        }
      }
    }

    // Cross-category weak similarities
    const allIds = products.map(p => p.id);
    for (let k = 0; k < 100; k++) {
      const a = pick(allIds);
      const b = pick(allIds);
      if (a === b) continue;
      const score = randBetween(0.1, 0.4);
      insertSimilarity.run(
        Math.min(a, b), Math.max(a, b),
        Math.round(score * 1000) / 1000,
        "Shared supply chain elements or manufacturing processes"
      );
      simCount++;
    }

    console.log(`Created ${simCount} similarity scores`);
  });
  similarityTx();

  // ─── Compute galaxy positions (3D layout) ───────────────────────────────

  const insertGalaxy = db.prepare(
    "INSERT OR REPLACE INTO pu_galaxy_positions (product_id, x, y, z, cluster) VALUES (?, ?, ?, ?, ?)"
  );

  const galaxyTx = db.transaction(() => {
    // Assign clusters by category
    const categories = [...new Set(products.map(p => p.category || "Other"))].sort();
    const catCluster = {};
    categories.forEach((c, i) => { catCluster[c] = i; });

    // Cluster centers spread around a sphere
    const clusterCenters = {};
    const numClusters = categories.length;
    for (let i = 0; i < numClusters; i++) {
      const phi = Math.acos(1 - 2 * (i + 0.5) / numClusters);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i; // golden angle
      const r = 60;
      clusterCenters[categories[i]] = {
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.sin(phi) * Math.sin(theta),
        z: r * Math.cos(phi),
      };
    }

    for (const product of products) {
      const cat = product.category || "Other";
      const cluster = catCluster[cat];
      const center = clusterCenters[cat];

      // Add jitter within cluster
      const jitter = 15;
      const x = center.x + (Math.random() - 0.5) * jitter * 2;
      const y = center.y + (Math.random() - 0.5) * jitter * 2;
      const z = center.z + (Math.random() - 0.5) * jitter * 2;

      insertGalaxy.run(
        product.id,
        Math.round(x * 100) / 100,
        Math.round(y * 100) / 100,
        Math.round(z * 100) / 100,
        cluster
      );
    }

    console.log(`Computed galaxy positions for ${products.length} products in ${numClusters} clusters`);
  });
  galaxyTx();

  // ─── Summary stats ──────────────────────────────────────────────────────

  const stats = {
    products: db.prepare("SELECT COUNT(*) as c FROM products WHERE pu_enriched = 1").get().c,
    materials: db.prepare("SELECT COUNT(*) as c FROM pu_materials").get().c,
    productMaterials: db.prepare("SELECT COUNT(*) as c FROM pu_product_materials").get().c,
    companies: db.prepare("SELECT COUNT(*) as c FROM pu_companies").get().c,
    locations: db.prepare("SELECT COUNT(*) as c FROM pu_locations").get().c,
    supplyChainNodes: db.prepare("SELECT COUNT(*) as c FROM pu_supply_chain_nodes").get().c,
    similarities: db.prepare("SELECT COUNT(*) as c FROM pu_product_similarity").get().c,
    galaxyPositions: db.prepare("SELECT COUNT(*) as c FROM pu_galaxy_positions").get().c,
    companyRelationships: db.prepare("SELECT COUNT(*) as c FROM pu_company_relationships").get().c,
  };

  console.log("\n=== Enrichment Complete ===");
  console.log(JSON.stringify(stats, null, 2));
}

seed();
db.close();
