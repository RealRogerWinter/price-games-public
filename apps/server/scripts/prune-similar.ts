import db from "../src/db";

const rows = db.prepare("SELECT id, title, category, price_cents FROM products WHERE is_active = 1 ORDER BY title").all() as {
  id: number; title: string; category: string; price_cents: number;
}[];

console.log(`Total active products before pruning: ${rows.length}\n`);

// Phase 1: Remove garbage entries (ad text, "Shop products from small business", etc.)
const garbagePatterns = [
  "Shop products from small business brands",
  "Shop products that have been wholly produced",
  "You're seeing this ad based on",
  "Click to see price",
];

const garbageIds: number[] = [];
for (const r of rows) {
  if (garbagePatterns.some(p => r.title.includes(p))) {
    garbageIds.push(r.id);
  }
}
console.log(`Phase 1: Removing ${garbageIds.length} garbage/ad entries`);

// Phase 2: Find duplicate groups and keep only the best one
const stopWords = new Set([
  "for", "the", "and", "with", "from", "that", "this", "pack", "pcs", "set",
  "inch", "size", "women", "men", "kids", "new", "best", "pro", "use", "your",
]);

const groups: Record<string, typeof rows> = {};
for (const r of rows) {
  if (garbageIds.includes(r.id)) continue; // skip garbage
  const words = r.title.toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 4)
    .join(" ");
  if (!groups[words]) groups[words] = [];
  groups[words].push(r);
}

const dupeIds: number[] = [];
let dupeGroupCount = 0;

for (const [key, items] of Object.entries(groups)) {
  if (items.length < 3) continue;
  dupeGroupCount++;

  // Score each item: prefer longer meaningful title, mid-range price
  const scored = items.map(item => {
    const titleLen = item.title.replace(/[^a-zA-Z0-9 ]/g, "").length;
    // Penalize very short or very generic titles
    const titleScore = Math.min(titleLen, 100);
    // Prefer items with unique prices (more interesting for the game)
    return { ...item, score: titleScore };
  }).sort((a, b) => b.score - a.score);

  // Keep the best one, deactivate the rest
  const keep = scored[0];
  const remove = scored.slice(1);

  console.log(`\n  Group "${key}" (${items.length} items) — keeping [${keep.id}] ${keep.title.substring(0, 60)}`);
  for (const r of remove) {
    console.log(`    deactivating [${r.id}] ${r.title.substring(0, 60)}`);
    dupeIds.push(r.id);
  }
}

// Also find near-exact title duplicates (same title, different IDs) even if group < 3
const titleMap: Record<string, typeof rows> = {};
for (const r of rows) {
  if (garbageIds.includes(r.id) || dupeIds.includes(r.id)) continue;
  const norm = r.title.toLowerCase().trim();
  if (!titleMap[norm]) titleMap[norm] = [];
  titleMap[norm].push(r);
}

const exactDupeIds: number[] = [];
for (const [, items] of Object.entries(titleMap)) {
  if (items.length < 2) continue;
  // Keep first, deactivate rest
  for (const r of items.slice(1)) {
    exactDupeIds.push(r.id);
    console.log(`\n  Exact dupe: deactivating [${r.id}] ${r.title.substring(0, 70)}`);
  }
}

const allDeactivateIds = [...new Set([...garbageIds, ...dupeIds, ...exactDupeIds])];

console.log(`\n=== Summary ===`);
console.log(`Garbage entries to remove: ${garbageIds.length}`);
console.log(`Duplicate groups pruned: ${dupeGroupCount}`);
console.log(`Exact title duplicates: ${exactDupeIds.length}`);
console.log(`Total items to deactivate: ${allDeactivateIds.length}`);

if (allDeactivateIds.length > 0) {
  const deactivate = db.prepare("UPDATE products SET is_active = 0 WHERE id = ?");
  const tx = db.transaction(() => {
    for (const id of allDeactivateIds) {
      deactivate.run(id);
    }
  });
  tx();
  console.log(`\nDeactivated ${allDeactivateIds.length} products.`);
}

const remaining = (db.prepare("SELECT COUNT(*) as c FROM products WHERE is_active = 1").get() as { c: number }).c;
console.log(`Active products remaining: ${remaining}`);

// Show category breakdown
const cats = db.prepare("SELECT category, COUNT(*) as c FROM products WHERE is_active = 1 GROUP BY category ORDER BY c DESC").all() as { category: string; c: number }[];
console.log(`\nCategory breakdown:`);
for (const cat of cats) {
  console.log(`  ${cat.category}: ${cat.c}`);
}
