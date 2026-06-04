---
title: Browser Extension
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: extension
summary: "Chrome extension for importing Amazon products: build, install, usage."
related_code:
  - apps/extension
---
# Chrome Extension

A Manifest V3 Chrome extension for importing Amazon products directly into the Price Games database. Located in `apps/extension/`.

## Features

- **Amazon product detection**: Automatically detects products on Amazon pages and extracts ASIN, title, price, image, and description
- **Universal detection**: Detects products on other retailers (Target, Best Buy, Walmart, Shopify) via JSON-LD, Open Graph, and microdata — then searches Amazon for matching products
- **Amazon search**: Search Amazon directly from the extension popup
- **One-click import**: Import detected products into the admin database
- **Admin authentication**: Authenticates with the admin panel via bearer token

## Building

```bash
npm run build -w apps/extension
```

This outputs to `apps/extension/dist/`.

## Installation

1. Build the extension (see above)
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the `apps/extension/dist/` directory

Alternatively, download the pre-built ZIP from the admin panel at `/admin/extension`.

## Authentication

1. Navigate to the extension popup
2. Enter the admin panel URL (e.g., `https://price.games`)
3. Log in with admin credentials
4. The extension stores a bearer token for subsequent API calls

The extension uses `POST /api/admin/extension/login` to obtain a token and `GET /api/admin/extension/verify` to validate it.

If the admin account has two-factor authentication (2FA) enabled, the login endpoint responds with `{ requiresTwoFactor: true, pendingToken }` instead of a token. The extension must then call `POST /api/admin/extension/login/verify-2fa` with the `pendingToken` and the 2FA code to complete authentication and obtain the bearer token.

## Usage

### On Amazon Product Pages
The extension automatically detects when you're on an Amazon product page and shows the product details (title, price, image) in the popup. Click **Import** to add it to the database.

### On Other Retailer Pages
The extension uses JSON-LD, Open Graph, and microdata to detect products on any supported retailer page. It then searches Amazon for a matching product to get an ASIN and standard pricing.

### Amazon Search
Open the extension popup and use the search bar to find products on Amazon without navigating away from your current page.

## Technical Details

- **Manifest Version**: 3
- **Permissions**: activeTab, storage, tabs, scripting
- **Host Permissions**: `https://www.amazon.com/*`, `https://price.games/*`, `https://*.ts.net/*` (Tailscale VPN, for connecting to a private/dev deployment)
- **Content Scripts**: Run on `https://www.amazon.com/*`
- **Background**: Service worker model

### Key Files

| File | Description |
|------|-------------|
| `src/background.ts` | Service worker — auth state, message routing |
| `src/content.ts` | Content script for Amazon product pages |
| `src/scraper.ts` | ASIN/price extraction from product pages |
| `src/product-detector.ts` | Universal product detection (JSON-LD, Open Graph, microdata) |
| `src/amazon-search-scraper.ts` | Extract products from Amazon search results |
| `src/api.ts` | Extension API client (login, import, verify) |
| `src/popup/` | Popup UI (HTML, TypeScript, CSS) |

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/admin/extension/login` | Authenticate (returns bearer token, or `requiresTwoFactor` + `pendingToken` if 2FA is enabled) |
| POST | `/api/admin/extension/login/verify-2fa` | Verify 2FA code with the pending token (returns bearer token) |
| GET | `/api/admin/extension/verify` | Validate token |
| POST | `/api/admin/extension/import` | Import product by ASIN |
| GET | `/api/admin/extension/download` | Download extension ZIP (admin auth) |

See [API_REFERENCE.md](API_REFERENCE.md) for full details.
