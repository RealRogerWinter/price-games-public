/**
 * Seed the sandbox database with test products.
 * Runs inside the production Docker image (CommonJS, no tsx).
 *
 * Usage: node /tmp/seed.js
 * (copied into container via `npm run sandbox:seed`)
 */

const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join("/app/apps/server/data", "price-game.db");
const db = new Database(dbPath);

const count = db.prepare("SELECT COUNT(*) as c FROM products").get().c;
if (count > 0) {
  console.log(`Database already has ${count} products — skipping seed.`);
  process.exit(0);
}

const products = [
  { asin: "B0CX23V2ZK", title: "Echo Dot (5th Gen)", price_cents: 4999, category: "Electronics" },
  { asin: "B0BSHF7WHW", title: "Stanley Quencher H2.0 Tumbler", price_cents: 3500, category: "Kitchen" },
  { asin: "B0C8Y5X95V", title: "Apple AirPods Pro 2", price_cents: 24999, category: "Electronics" },
  { asin: "B0D1XD1ZV3", title: "Kindle Paperwhite (11th Gen)", price_cents: 14999, category: "Electronics" },
  { asin: "B0BT2KFJ44", title: "Ninja Creami Ice Cream Maker", price_cents: 19999, category: "Kitchen" },
  { asin: "B09V3KXJPB", title: "Lego Flower Bouquet", price_cents: 4999, category: "Toys & Games" },
  { asin: "B0BDJF9M23", title: "Dyson V15 Detect", price_cents: 74999, category: "Home" },
  { asin: "B0CHX3QBCH", title: "PlayStation 5 Slim", price_cents: 44999, category: "Electronics" },
  { asin: "B0CL61F39H", title: "Crocs Classic Clog", price_cents: 4999, category: "Fashion" },
  { asin: "B0CXDR5JQR", title: "Yeti Rambler 26oz Bottle", price_cents: 3500, category: "Kitchen" },
];

const now = new Date().toISOString();
const insert = db.prepare(
  "INSERT OR IGNORE INTO products (asin, title, image_url, price_cents, category, is_active, scraped_at, added_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
);

db.transaction(() => {
  for (const p of products) {
    insert.run(p.asin, p.title, "", p.price_cents, p.category, now, now);
  }
})();

const final = db.prepare("SELECT COUNT(*) as c FROM products").get().c;
console.log(`Seeded ${final} test products.`);
