import db from "../src/db";

const rows = db.prepare("SELECT id, title, category, price_cents FROM products WHERE is_active = 1 ORDER BY title").all() as {
  id: number; title: string; category: string; price_cents: number;
}[];

const stopWords = new Set(["for", "the", "and", "with", "from", "that", "this", "pack", "pcs", "set", "inch", "size", "women", "men", "kids", "new", "best", "pro", "use"]);

const groups: Record<string, typeof rows> = {};
for (const r of rows) {
  const words = r.title.toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 4)
    .join(" ");
  if (!groups[words]) groups[words] = [];
  groups[words].push(r);
}

const dupes = Object.entries(groups)
  .filter(([, v]) => v.length >= 3)
  .sort((a, b) => b[1].length - a[1].length);

console.log("Groups with 3+ similar items:\n");
for (const [key, items] of dupes) {
  console.log(`--- ${key} (${items.length} items) ---`);
  for (const item of items) {
    console.log(`  [${item.id}] $${(item.price_cents / 100).toFixed(2)} | ${item.category} | ${item.title.substring(0, 90)}`);
  }
  console.log();
}
console.log(`Total duplicate groups (3+): ${dupes.length}`);
