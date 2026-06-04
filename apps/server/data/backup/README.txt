=== PRODUCT DATA BACKUP ===
Created: 2026-03-10

DO NOT DELETE THIS DIRECTORY OR ITS CONTENTS.

This backup contains the original scraped Amazon product data (JSON files)
for the price.games application. These files were scraped from Amazon via
web searches, listicles, and product pages. Re-scraping is difficult due
to Amazon's bot detection.

Each JSON file contains an array of products with:
  - asin: Amazon Standard Identification Number
  - title: Product name
  - price_cents: Price in cents (integer)
  - image_url: Amazon CDN image URL (may be empty for some)
  - category: Product category name

To reload from backup:
  node apps/server/src/load-from-backup.js

Total products: ~1,750 across 19 categories.
