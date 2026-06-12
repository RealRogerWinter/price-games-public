---
title: Product Universe
status: beta
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: game-design
summary: "AI-enriched product taxonomy, the galaxy visualization, and manufacturer tracking."
related_code:
  - apps/server/src/routes/universe.ts
  - apps/web/src/pages/universe
---
# Product Universe

The Product Universe is an AI-powered knowledge graph that enriches the product catalog with materials, supply chains, company relationships, and 3D galaxy visualization.

## Overview

- **Enrichment**: AI-generated product summaries, material breakdowns, supply chain data, and company information
- **Galaxy View**: 3D visualization of products as stars, grouped by category
- **Company Web**: Corporate relationship graphs showing parent companies, subsidiaries, and competitors
- **Material Journeys**: Supply chain visualization from raw materials to finished products

## Enrichment Tiers

Products have three enrichment states tracked in the `products` table:
- **Unenriched** (`pu_enriched = 0`): Base product data only
- **Enriching** (job in progress): Enrichment pipeline running
- **Enriched** (`pu_enriched = 1`): Full AI-generated data available

Enrichment is triggered on-demand when a product is searched or viewed in the Universe.

## API Endpoints

All endpoints are under `/api/pu/`. See [API_REFERENCE.md](API_REFERENCE.md) for details.

### Product Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/pu/search` | Search products (triggers enrichment) |
| GET | `/api/pu/product/:id` | Full product detail with enrichment |
| GET | `/api/pu/product/:id/cards` | AI-generated summary cards |
| GET | `/api/pu/product/:id/supply-chain` | Geographic supply chain |
| GET | `/api/pu/product/:id/materials` | Materials breakdown |
| GET | `/api/pu/product/:id/related?limit={n}` | Similar/related products |

### Galaxy Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/pu/galaxy?limit={n}` | 3D galaxy data (max 5000 nodes) |
| GET | `/api/pu/galaxy/product/:id` | Galaxy centered on product |

### Company Endpoints
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/pu/companies?q={query}&limit={n}` | Search companies |
| GET | `/api/pu/company/:id` | Company detail + relationships |
| GET | `/api/pu/company/:id/web` | Corporate relationship graph |

### Stats
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/pu/stats` | Public universe statistics |

## Database Tables

The Product Universe uses 13 dedicated tables (all prefixed `pu_`). See [DATABASE.md](DATABASE.md) for the full schema.

Key tables:
- `pu_materials` / `pu_product_materials` — material knowledge and product links
- `pu_companies` / `pu_company_relationships` / `pu_product_companies` — company graph
- `pu_locations` / `pu_supply_chain_nodes` / `pu_material_locations` — geographic data
- `pu_product_similarity` — product similarity scores
- `pu_galaxy_positions` — 3D visualization coordinates
- `pu_enrichment_jobs` — pipeline job tracking
- `pu_search_cache` — search result caching
- `pu_sources` — data source references

## Future Plans

A Product Universe v2 is under consideration, covering tiered enrichment
(Hero + Derive + On-Demand), an expanded product-class taxonomy, a 4-level
galaxy drill-down (Universe → Galaxy → Star System → Star Cluster), and
cross-cutting views such as Material Journeys, Company Webs, and a Timeline.
Open an issue if you'd like to help shape it.

**Source**: `apps/server/src/routes/universe.ts`
