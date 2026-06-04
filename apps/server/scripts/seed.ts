import db from "../src/db";

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  ⚠  WARNING: This script DELETES ALL PRODUCTS.              ║
 * ║                                                               ║
 * ║  Product data is scraped from Amazon and is EXPENSIVE to     ║
 * ║  re-collect. Use the pipeline instead:                       ║
 * ║                                                               ║
 * ║    npx tsx src/pipeline/scrape-amazon.ts   # add products    ║
 * ║    npx tsx src/pipeline/backup-restore.ts backup  # backup   ║
 * ║    npx tsx src/pipeline/backup-restore.ts restore # restore  ║
 * ║    npx tsx src/pipeline/verify-products.ts        # verify   ║
 * ║                                                               ║
 * ║  Only run this seed script if you truly need to reset to     ║
 * ║  the static seed data. It will DESTROY all scraped data.     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */

// Safety check: require --force flag
if (!process.argv.includes("--force")) {
  const count = (db.prepare("SELECT COUNT(*) as c FROM products").get() as { c: number }).c;
  if (count > 0) {
    console.error("╔════════════════════════════════════════════════════════╗");
    console.error(`║  ABORTED: Database has ${count} products.`.padEnd(57) + "║");
    console.error("║                                                        ║");
    console.error("║  Running seed will DELETE all scraped product data.     ║");
    console.error("║  This data takes hours to re-scrape from Amazon.       ║");
    console.error("║                                                        ║");
    console.error("║  If you really want to do this, run with --force:      ║");
    console.error("║    npm run seed -- --force                              ║");
    console.error("║                                                        ║");
    console.error("║  Better alternatives:                                   ║");
    console.error("║    npm run pipeline        # add more products         ║");
    console.error("║    npm run backup          # backup before changes     ║");
    console.error("║    npm run restore         # restore from backup       ║");
    console.error("╚════════════════════════════════════════════════════════╝");
    process.exit(1);
  }
}

// Auto-backup before destroying data
import fs from "fs";
import path from "path";
const backupDir = path.join(__dirname, "..", "data", "backup");
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

const existing = db.prepare(
  "SELECT asin, title, image_url, price_cents, category, scraped_at FROM products WHERE is_active = 1"
).all();
if (existing.length > 0) {
  const backupPath = path.join(backupDir, `pre_seed_backup_${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(existing, null, 2));
  console.log(`Auto-backed up ${existing.length} products to ${backupPath}\n`);
}

import { SEED_PRODUCTS } from "./seed-data";

console.log("=== Price Game Seed Script ===\n");
console.log(`Total products to insert: ${SEED_PRODUCTS.length}`);

// Clear existing data respecting FK constraints
console.log("Clearing existing data...");
db.prepare("DELETE FROM game_rounds").run();
db.prepare("DELETE FROM game_sessions").run();
db.prepare("DELETE FROM products").run();

// Insert all products in a transaction
console.log("Inserting products into database...");
const insert = db.prepare(
  `INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active)
   VALUES (?, ?, ?, ?, ?, ?, 1)`
);

const insertMany = db.transaction(() => {
  for (const p of SEED_PRODUCTS) {
    const imageUrl = `https://images-na.ssl-images-amazon.com/images/P/${p.asin}.01._SCLZZZZZZZ_SX500_.jpg`;
    insert.run(p.asin, p.title, imageUrl, p.title, p.price_cents, p.category);
  }
});

insertMany();

const countByCategory: Record<string, number> = {};
for (const p of SEED_PRODUCTS) {
  countByCategory[p.category] = (countByCategory[p.category] || 0) + 1;
}

console.log(`\n=== Seed Complete ===`);
console.log(`Total products inserted: ${SEED_PRODUCTS.length}\n`);
for (const [cat, count] of Object.entries(countByCategory)) {
  console.log(`  ${cat}: ${count} products`);
}
console.log("\nDone!");
