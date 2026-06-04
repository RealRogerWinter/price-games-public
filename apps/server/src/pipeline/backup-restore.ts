import fs from "fs";
import path from "path";
import db from "../db";

/**
 * BACKUP & RESTORE utility for the product database.
 *
 * Usage:
 *   npx tsx src/pipeline/backup-restore.ts backup     # export DB → JSON backup
 *   npx tsx src/pipeline/backup-restore.ts restore     # import JSON backup → DB
 *   npx tsx src/pipeline/backup-restore.ts status      # show backup vs DB stats
 */

const BACKUP_DIR = path.join(__dirname, "..", "..", "data", "backup");

interface BackupProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
  scraped_at: string;
}

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function backupFromDb() {
  ensureDir();

  const products = db.prepare(
    "SELECT asin, title, image_url, price_cents, category, scraped_at FROM products WHERE is_active = 1 ORDER BY category, id"
  ).all() as BackupProduct[];

  // Group by category
  const byCategory: Record<string, BackupProduct[]> = {};
  for (const p of products) {
    const cat = p.category || "Uncategorized";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }

  let totalBacked = 0;
  for (const [category, items] of Object.entries(byCategory)) {
    const safeName = category.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const filePath = path.join(BACKUP_DIR, `${safeName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2));
    console.log(`  ${category}: ${items.length} products → ${safeName}.json`);
    totalBacked += items.length;
  }

  // Write master manifest
  const manifest = {
    backed_up_at: new Date().toISOString(),
    total_products: totalBacked,
    categories: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
  };
  fs.writeFileSync(path.join(BACKUP_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`\nTotal: ${totalBacked} products backed up to ${BACKUP_DIR}`);
  return totalBacked;
}

function restoreToDb() {
  ensureDir();

  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json" && f !== "README.txt");

  if (files.length === 0) {
    console.error("No backup files found in", BACKUP_DIR);
    process.exit(1);
  }

  // Add columns if missing
  try { db.exec("ALTER TABLE products ADD COLUMN scraped_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE products ADD COLUMN added_at TEXT"); } catch {}
  try { db.exec("ALTER TABLE products ADD COLUMN verified INTEGER DEFAULT 0"); } catch {}

  const existingAsins = new Set<string>();
  const rows = db.prepare("SELECT asin FROM products WHERE asin IS NOT NULL").all() as { asin: string }[];
  for (const r of rows) existingAsins.add(r.asin);

  const insert = db.prepare(
    `INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active, scraped_at, added_at, verified)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`
  );

  const now = new Date().toISOString();
  let inserted = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const f of files) {
      const data: BackupProduct[] = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), "utf-8"));
      for (const p of data) {
        if (existingAsins.has(p.asin)) { skipped++; continue; }
        if (!p.image_url || p.image_url.length < 10) { skipped++; continue; }
        if (!p.price_cents || p.price_cents < 100) { skipped++; continue; }
        existingAsins.add(p.asin);
        insert.run(p.asin, p.title, p.image_url, p.title, p.price_cents, p.category, p.scraped_at || now, now);
        inserted++;
      }
    }
  });

  tx();
  db.pragma("wal_checkpoint(TRUNCATE)");

  console.log(`Restored: ${inserted} products (${skipped} skipped)`);
  return inserted;
}

function showStatus() {
  ensureDir();

  // DB stats
  const dbTotal = (db.prepare("SELECT COUNT(*) as c FROM products").get() as { c: number }).c;
  const dbCats = db.prepare("SELECT category, COUNT(*) as c FROM products WHERE is_active = 1 GROUP BY category ORDER BY c DESC").all() as { category: string; c: number }[];
  const dbVerified = (db.prepare("SELECT COUNT(*) as c FROM products WHERE verified = 1").get() as { c: number }).c;

  console.log("DATABASE:");
  console.log(`  Total: ${dbTotal} (${dbVerified} verified)`);
  for (const r of dbCats) console.log(`    ${r.category}: ${r.c}`);

  // Backup stats
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json" && f !== "README.txt");
  let backupTotal = 0;
  console.log("\nBACKUP:");
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), "utf-8"));
      console.log(`    ${f}: ${data.length} products`);
      backupTotal += data.length;
    } catch { /* skip */ }
  }
  console.log(`  Total: ${backupTotal} products in ${files.length} files`);

  const manifestPath = path.join(BACKUP_DIR, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    console.log(`  Last backup: ${manifest.backed_up_at}`);
  }
}

const command = process.argv[2];
switch (command) {
  case "backup":
    console.log("Backing up database to JSON...\n");
    backupFromDb();
    break;
  case "restore":
    console.log("Restoring from backup JSON → database...\n");
    restoreToDb();
    break;
  case "status":
    showStatus();
    break;
  default:
    console.log("Usage: npx tsx src/pipeline/backup-restore.ts [backup|restore|status]");
    process.exit(1);
}
