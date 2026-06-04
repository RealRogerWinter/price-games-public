# Manufacturer Contacts Pipeline

Extracts manufacturer/brand information from the Price Game product database and searches the web for media, PR, and promotional contact information. Designed to be orchestrated by Claude Code.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌───────────────────┐
│  Game Database   │────▶│  Manufacturer         │────▶│  Contacts Database │
│  (products)      │     │  Extraction           │     │  (manufacturer-    │
│  price-game.db   │     │  extract-manufacturers│     │   contacts.db)     │
└─────────────────┘     └──────────────────────┘     └───────────────────┘
                                                              │
                         ┌──────────────────────┐             │
                         │  Claude Code          │◀────────────┘
                         │  Sub-agents           │    read pending
                         │  (WebSearch/WebFetch)  │    manufacturers
                         └──────────┬───────────┘
                                    │
                                    ▼ load results
                         ┌───────────────────────┐
                         │  Contacts Database     │
                         │  (contacts, search_log)│
                         └───────────────────────┘
```

## Database Schema

Stored in `apps/server/data/manufacturer-contacts.db` (separate from the game DB).

### manufacturers
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| name | TEXT UNIQUE | Canonical brand name (e.g., "Apple") |
| normalized_name | TEXT UNIQUE | Lowercase for dedup |
| website | TEXT | Main company website |
| product_count | INTEGER | Products in our database |
| search_status | TEXT | 'pending', 'searched', 'verified' |
| created_at | TEXT | ISO 8601 timestamp |
| updated_at | TEXT | ISO 8601 timestamp |

### contacts
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| manufacturer_id | INTEGER FK | References manufacturers(id) |
| contact_type | TEXT | 'media', 'promotions', 'pr', 'partnerships', 'general', 'support' |
| email | TEXT | Contact email address |
| phone | TEXT | Phone number |
| contact_page_url | TEXT | Official contact/press page |
| source_url | TEXT | Where the info was found |
| confidence | TEXT | 'high', 'medium', 'low' |
| notes | TEXT | Free-form notes |
| verified_at | TEXT | When manually verified |
| created_at | TEXT | ISO 8601 timestamp |
| updated_at | TEXT | ISO 8601 timestamp |

### search_log
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| manufacturer_id | INTEGER FK | References manufacturers(id) |
| query | TEXT | Search query used |
| source | TEXT | Search engine / method |
| results_found | INTEGER | Number of results found |
| searched_at | TEXT | ISO 8601 timestamp |

## CLI Commands

```bash
# From apps/server/ directory:
npm run contacts                    # Show help
npm run contacts:extract            # Extract manufacturers from product DB
npm run contacts:status             # Show pipeline progress
npm run contacts:pending            # List manufacturers needing search
npm run contacts:backup             # Create JSON backup
npm run contacts:dump               # Dump all data as JSON

# With arguments (use npx tsx directly):
npx tsx src/pipeline/manufacturer-contacts/run-pipeline.ts queries "Apple"
npx tsx src/pipeline/manufacturer-contacts/run-pipeline.ts load '{"manufacturer":"Apple",...}'
npx tsx src/pipeline/manufacturer-contacts/run-pipeline.ts restore path/to/backup.json
```

## Pipeline Workflow

### Step 1: Extract Manufacturers
```bash
npm run contacts:extract
```
- Reads all active products from the game database
- Extracts manufacturer/brand names from product titles
- Uses known-brand dictionary + alias mapping + heuristic extraction
- Loads unique manufacturers into the contacts database
- Reports any low-confidence extractions that may need web verification

### Step 2: Search for Contacts (Claude Code orchestrated)

For each pending manufacturer, Claude Code:
1. Runs `queries <name>` to get search queries + agent prompt
2. Launches sub-agents with WebSearch/WebFetch to find contacts
3. Collects results as a ContactSearchResult JSON
4. Runs `load <json>` to store results in the database

### Step 3: Review & Backup
```bash
npm run contacts:status             # Check progress
npm run contacts:dump               # Review all data
npm run contacts:backup             # Save backup
```

## Backup Strategy

- Backups are stored in `apps/server/data/backup/manufacturer-contacts/`
- Each backup is a single JSON file with timestamped filename
- Contains all manufacturers, contacts, and search logs
- Restores skip duplicate manufacturers (idempotent)
- **Recommended:** Run `npm run contacts:backup` after each batch of searches

## Manufacturer Extraction Logic

The extraction uses a three-tier approach:

1. **Multi-word brand matching** — Checked first, longest match wins. Handles "The North Face", "La Roche-Posay", "Instant Pot", etc.
2. **Single-word brand matching** — Matches known brands at the start of the title. Handles "Apple", "Sony", "LEGO", etc.
3. **Alias resolution** — Maps sub-brands to parent companies: "PlayStation" → "Sony", "Echo Dot" → "Amazon", "Hasbro Gaming" → "Hasbro".
4. **Fallback** — Uses first word of title as low-confidence guess.

## Existing Database Migration

Migration v4 adds a `manufacturer TEXT` column to the products table in the game database. The scraper pipeline has been updated to:
- Extract brand name from Amazon product pages (`#bylineInfo` element, `Brand:` detail row)
- Store manufacturer in the `manufacturer` column on new scrapes

## Module Reference

| Module | Purpose |
|--------|---------|
| `types.ts` | Shared TypeScript types |
| `contacts-db.ts` | Contacts database CRUD operations |
| `extract-manufacturers.ts` | Brand extraction from product titles |
| `search-contacts.ts` | Search query generation, result validation |
| `backup.ts` | Backup/restore for contacts database |
| `run-pipeline.ts` | CLI entry point |

## Tests

```bash
# Run pipeline tests only:
npx vitest run apps/server/src/pipeline/manufacturer-contacts/

# Run all server tests (includes pipeline):
npm run test:server
```

105 tests covering:
- Database CRUD operations (32 tests)
- Manufacturer extraction for all 125 seed products (39 tests)
- Search query generation and result validation (20 tests)
- Backup/restore lifecycle (14 tests)
