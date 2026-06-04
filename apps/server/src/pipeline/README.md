# Product Pipeline

Repeatable process for searching, scraping, verifying, and loading Amazon product data.

## Commands

```bash
# From apps/server directory:

# === SEARCH MODE (default) ===
# Full pipeline — scrape all 19 categories from Amazon search results
npm run pipeline

# Single category
npm run pipeline:category -- Kitchen

# Preview only (no DB changes)
npm run pipeline:dry-run

# === ASIN MODE ===
# Scrape specific ASINs from individual product pages
npx tsx src/pipeline/scrape-amazon.ts asin --asins B0D1XD1ZV3,B00FLYWNYQ --category Electronics
npx tsx src/pipeline/scrape-amazon.ts asin --file asins.txt --category Kitchen

# === DISCOVER MODE ===
# Search blogs for product recommendations, extract ASINs, scrape those products
npx tsx src/pipeline/scrape-amazon.ts discover --category "Weird and Wonderful"

# === MAINTENANCE ===
# Backup current DB to JSON
npm run backup

# Restore from JSON backup into DB
npm run restore

# Check backup vs DB status
npm run backup:status

# Verify all product images/prices/titles in DB
npm run verify

# Verify AND deactivate broken products
npm run verify:fix
```

## Three Scraping Modes

### 1. Search Mode (default)
Scrapes Amazon search results pages. Fast (~20 products per query). Best for filling categories with diverse products.

From each search result page, extracts:
- **ASIN** — from `data-asin` HTML attributes
- **Title** — from the longest `<span>` text in the product block
- **Price** — from `a-offscreen` price spans
- **Image URL** — from `<img src>` tags, upgraded to `_AC_SL1500_` resolution

### 2. ASIN Mode
Scrapes individual Amazon product pages (`/dp/ASIN`). Slower (6-12s per product) but targets exact products. Provide ASINs via `--asins` or `--file`.

From each product page, extracts:
- **Title** — from `#productTitle` or `<title>` tag
- **Price** — first `$X.XX` pattern on the page
- **Image URL** — from `hiRes`, `large`, `og:image`, or `landingImageUrl` in page source

### 3. Discover Mode
Searches Google for blog articles about a category (e.g., "best Amazon kitchen gadgets"), extracts ASINs from `/dp/ASIN` links in those articles, then scrapes each discovered ASIN individually. Finds curated, interesting products that humans recommend.

## Data Integrity

**ALL data comes directly from Amazon's HTML.** Nothing is fabricated. If a scrape fails to extract real data, the product is skipped entirely.

Every image URL is verified via HTTP HEAD request:
- Must return HTTP 200
- Must be >500 bytes (rejects 1x1 pixel placeholders)
- Products that fail verification are excluded

## Backup & Load

Verified products are saved to `data/backup/{category}.json` before DB insertion. Backups are **additive** — new products merge with existing backups.

Products are inserted into the SQLite database with:
- `scraped_at` — when the data was scraped from Amazon
- `added_at` — when it was loaded into the DB
- `verified` — set to 1 after image verification passes

The loader is **additive** — it never deletes existing products. Duplicate ASINs are skipped.

## Rate Limiting
- **8-15 second** random delays between Amazon search requests
- **6-12 second** delays between individual product page scrapes
- **CAPTCHA detection**: backs off 15s on first CAPTCHA, 90s after 3 in a row
- Full search-mode pipeline for all 19 categories takes ~60-90 minutes

## Anti-Deletion Safeguards
- `seed.ts` requires `--force` flag to run if products exist
- `seed.ts` auto-backs up all products before clearing
- The pipeline never deletes — only adds
- All scraped data is persistently backed up to `data/backup/`

## Categories (19)
Fashion, Electronics, Jewelry, Beauty, Kitchen, Weird and Wonderful, Costumes, Baby, Music, Collectibles, Figurines, Furniture, Home Decor, Pet, Foods, Arts & Crafts, Garden & Outdoor, Toys, Tools & Home Improvement

## Files
- `scrape-amazon.ts` — Multi-mode pipeline: search/asin/discover → verify → backup → load
- `backup-restore.ts` — Backup DB to JSON / restore from JSON
- `verify-products.ts` — Verify all products have working images and valid data
