/**
 * Popup script — manages the extension popup UI.
 *
 * Communicates with the background service worker for API calls and
 * with the content script (via chrome.tabs.sendMessage) for scraping.
 * Supports both Amazon product pages (direct import) and generic e-commerce
 * pages (detect product → search Amazon → open match).
 */

import type { ScrapedProduct, RawStructuredData } from "../content";
import type { AmazonSearchResult } from "../amazon-search-scraper";
import { detectProduct, buildAmazonSearchQuery, type GenericProduct } from "../product-detector";

// DOM elements — existing views
const loginView = document.getElementById("login-view")!;
const noProductView = document.getElementById("no-product-view")!;
const productView = document.getElementById("product-view")!;
const loadingView = document.getElementById("loading-view")!;

// DOM elements — new views
const genericProductView = document.getElementById("generic-product-view")!;

const loginForm = document.getElementById("login-form") as HTMLFormElement;
const loginError = document.getElementById("login-error")!;
const usernameInput = document.getElementById("username") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;

const productImage = document.getElementById("product-image") as HTMLImageElement;
const productTitle = document.getElementById("product-title")!;
const productPrice = document.getElementById("product-price")!;
const productMfg = document.getElementById("product-manufacturer")!;
const productAsin = document.getElementById("product-asin")!;
const categorySelect = document.getElementById("category-select") as HTMLSelectElement;
const importBtn = document.getElementById("import-btn") as HTMLButtonElement;
const importStatus = document.getElementById("import-status")!;

// Generic product elements
const genericProductImage = document.getElementById("generic-product-image") as HTMLImageElement;
const genericProductTitle = document.getElementById("generic-product-title")!;
const genericProductPrice = document.getElementById("generic-product-price")!;
const genericProductBrand = document.getElementById("generic-product-brand")!;
const searchStatus = document.getElementById("search-status")!;
const searchResultsContainer = document.getElementById("search-results-container")!;

const allViews = [loginView, noProductView, productView, loadingView, genericProductView];

let currentProduct: ScrapedProduct | null = null;

/** Check that a URL uses http: or https: scheme (safe for img.src / chrome.tabs.create). */
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Show a single view, hide all others. */
function showView(view: HTMLElement): void {
  allViews.forEach((v) => v.classList.add("hidden"));
  view.classList.remove("hidden");
}

/** Format cents to dollar string. */
function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Send a message to the background service worker. */
function sendBackground(message: Record<string, unknown>): Promise<any> {
  return chrome.runtime.sendMessage(message);
}

/** Send a message to the content script in the active tab. */
async function sendContentScript(message: Record<string, unknown>): Promise<any> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    return null;
  }
}

/** Check if the active tab is an Amazon product page. */
async function isAmazonProductPage(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return false;
  return /amazon\.com\/(dp\/|.*\/dp\/|gp\/product\/)/.test(tab.url);
}

/** Load available categories into the dropdown. */
async function loadCategories(detected: string | null): Promise<void> {
  const result = await sendBackground({ type: "FETCH_CATEGORIES" });
  const categories: string[] = result?.categories || [];

  categorySelect.replaceChildren();

  // Add detected category first if it exists
  if (detected) {
    const opt = document.createElement("option");
    opt.value = detected;
    opt.textContent = `${detected} (detected)`;
    opt.selected = true;
    categorySelect.appendChild(opt);
  }

  for (const cat of categories) {
    if (cat === detected) continue; // skip duplicate
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    categorySelect.appendChild(opt);
  }

  // Add a "No category" option
  const noCat = document.createElement("option");
  noCat.value = "";
  noCat.textContent = "— No category —";
  categorySelect.appendChild(noCat);
}

/** Display scraped product data in the preview card (Amazon flow). */
function showProductPreview(product: ScrapedProduct): void {
  currentProduct = product;

  productTitle.textContent = product.title || "Unknown title";
  productTitle.title = product.title || "";
  productPrice.textContent = product.priceCents ? formatPrice(product.priceCents) : "Price unavailable";
  productMfg.textContent = product.manufacturer || "";
  productAsin.textContent = product.asin ? `ASIN: ${product.asin}` : "";

  if (product.imageUrl && isSafeUrl(product.imageUrl)) {
    productImage.src = product.imageUrl;
    productImage.classList.remove("hidden");
  } else {
    productImage.classList.add("hidden");
  }

  loadCategories(product.category);
  showView(productView);
}

/** Display a detected generic product and auto-trigger Amazon search. */
function showGenericProductPreview(product: GenericProduct): void {
  genericProductTitle.textContent = product.title || "Unknown title";
  genericProductTitle.title = product.title || "";
  genericProductPrice.textContent = product.priceCents ? formatPrice(product.priceCents) : "";
  genericProductBrand.textContent = product.brand || "";

  if (product.imageUrl && isSafeUrl(product.imageUrl)) {
    genericProductImage.src = product.imageUrl;
    genericProductImage.classList.remove("hidden");
  } else {
    genericProductImage.classList.add("hidden");
  }

  searchStatus.textContent = "Searching Amazon...";
  searchStatus.classList.remove("hidden");
  searchResultsContainer.classList.add("hidden");
  searchResultsContainer.replaceChildren();

  showView(genericProductView);
}

/**
 * Render Amazon search result cards in the results container.
 *
 * Always includes a "Search Amazon Manually" link at the bottom in case
 * the automated results don't include the right product.
 */
function renderSearchResults(results: AmazonSearchResult[], searchUrl: string): void {
  searchResultsContainer.replaceChildren();

  for (const result of results) {
    const item = document.createElement("div");
    item.className = "search-result-item";

    const img = document.createElement("img");
    img.className = "search-result-thumb";
    img.alt = result.title;
    if (result.imageUrl && isSafeUrl(result.imageUrl)) {
      img.src = result.imageUrl;
    } else {
      img.style.display = "none";
    }

    const info = document.createElement("div");
    info.className = "search-result-info";

    const title = document.createElement("p");
    title.className = "search-result-title";
    title.textContent = result.title;
    title.title = result.title;

    const price = document.createElement("p");
    price.className = "search-result-price";
    price.textContent = result.priceCents ? formatPrice(result.priceCents) : "";

    info.appendChild(title);
    info.appendChild(price);

    const btnGroup = document.createElement("div");
    btnGroup.className = "btn-group";

    const importResultBtn = document.createElement("button");
    importResultBtn.className = "btn-import-result";
    importResultBtn.textContent = "Import";
    importResultBtn.addEventListener("click", () => handleResultImport(result, importResultBtn));

    const openBtn = document.createElement("button");
    openBtn.className = "btn-open";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", () => handleResultClick(result));

    btnGroup.appendChild(importResultBtn);
    btnGroup.appendChild(openBtn);

    item.appendChild(img);
    item.appendChild(info);
    item.appendChild(btnGroup);
    searchResultsContainer.appendChild(item);
  }

  // Always add a manual search link at the bottom
  const manualDiv = document.createElement("div");
  manualDiv.style.textAlign = "center";
  manualDiv.style.padding = "8px 0";
  const link = document.createElement("a");
  link.href = searchUrl;
  link.className = "btn-link";
  link.textContent = "Not the right product? Search Amazon manually";
  link.style.fontSize = "12px";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    if (!isSafeUrl(searchUrl)) return;
    chrome.tabs.create({ url: searchUrl, active: true });
    window.close();
  });
  manualDiv.appendChild(link);
  searchResultsContainer.appendChild(manualDiv);

  searchStatus.classList.add("hidden");
  searchResultsContainer.classList.remove("hidden");
}

/** Handle clicking on an Amazon search result — open the product page. */
function handleResultClick(result: AmazonSearchResult): void {
  if (!isSafeUrl(result.productUrl)) return;
  chrome.tabs.create({ url: result.productUrl, active: true });
  window.close();
}

/**
 * Import a search result by first scraping the full Amazon product page
 * to get manufacturer, category, and description, then importing.
 */
async function handleResultImport(result: AmazonSearchResult, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "Scraping...";

  // Scrape the full product page in a background tab
  const scrapeResp = await sendBackground({
    type: "SCRAPE_AMAZON_PAGE",
    url: result.productUrl,
  });

  const scraped = scrapeResp?.ok ? scrapeResp.product : null;

  // Use scraped data if available, fall back to search result data (use ?? to preserve falsy values like 0)
  const asin = scraped?.asin ?? result.asin;
  const title = scraped?.title ?? result.title;
  const priceCents = scraped?.priceCents ?? result.priceCents;

  if (!priceCents) {
    showImportFeedback(btn, false, "No price");
    return;
  }

  btn.textContent = "Importing...";

  const resp = await sendBackground({
    type: "IMPORT_PRODUCT",
    data: {
      asin,
      title,
      priceCents,
      imageUrl: scraped?.imageUrl || result.imageUrl || undefined,
      manufacturer: scraped?.manufacturer || undefined,
      category: scraped?.category || undefined,
      description: scraped?.description || undefined,
    },
  });

  if (resp?.ok) {
    showImportFeedback(btn, true, resp.created ? "Created!" : "Updated!");
  } else {
    showImportFeedback(btn, false, resp?.error || "Failed");
  }
}

/** Show brief feedback on a search result import button. */
function showImportFeedback(btn: HTMLButtonElement, success: boolean, text: string): void {
  btn.textContent = text;
  btn.style.background = success ? "#27ae60" : "#e74c3c";
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = "Import";
    btn.style.background = "";
    btn.disabled = false;
  }, 2000);
}

/**
 * Search Amazon for the detected product via background worker.
 *
 * Always stays on the generic product view. Shows results if found,
 * otherwise shows a manual search link — never abandons the detected product.
 */
async function searchAmazon(product: GenericProduct): Promise<void> {
  const query = buildAmazonSearchQuery(product);
  const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query || product.title || "")}`;

  if (!query) {
    showSearchFallback(searchUrl);
    return;
  }

  const result = await sendBackground({ type: "AMAZON_SEARCH", query });
  const manualUrl = result?.searchUrl || searchUrl;

  if (result?.ok && Array.isArray(result.results) && result.results.length > 0) {
    renderSearchResults(result.results, manualUrl);
  } else {
    showSearchFallback(manualUrl);
  }
}

/** Show the manual search fallback link in the generic product view. */
function showSearchFallback(searchUrl: string): void {
  searchStatus.textContent = "";
  searchStatus.classList.add("hidden");
  searchResultsContainer.replaceChildren();

  const fallbackEl = document.createElement("div");
  fallbackEl.style.textAlign = "center";
  fallbackEl.style.padding = "8px 0";

  const link = document.createElement("a");
  link.href = searchUrl;
  link.target = "_blank";
  link.className = "btn-manual-search";
  link.textContent = "Search Amazon Manually";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    if (!isSafeUrl(searchUrl)) return;
    chrome.tabs.create({ url: searchUrl, active: true });
    window.close();
  });

  fallbackEl.appendChild(link);
  searchResultsContainer.appendChild(fallbackEl);
  searchResultsContainer.classList.remove("hidden");
}

/** Inject content script into the active tab on demand. */
async function injectContentScript(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Show the import result. */
function showImportResult(success: boolean, message: string): void {
  importStatus.textContent = message;
  importStatus.className = success ? "success" : "error";
  importStatus.classList.remove("hidden");
}

// ─── Event handlers ───

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) return;

  const loginBtn = document.getElementById("login-btn") as HTMLButtonElement;
  loginBtn.disabled = true;

  const result = await sendBackground({ type: "LOGIN", username, password });

  loginBtn.disabled = false;

  if (result?.ok) {
    await initialize();
  } else {
    loginError.textContent = result?.error || "Login failed";
    loginError.classList.remove("hidden");
  }
});

importBtn.addEventListener("click", async () => {
  if (!currentProduct?.asin || !currentProduct?.title || !currentProduct?.priceCents) {
    showImportResult(false, "Missing required product data (ASIN, title, or price)");
    return;
  }

  importBtn.disabled = true;
  importBtn.textContent = "Importing...";

  const result = await sendBackground({
    type: "IMPORT_PRODUCT",
    data: {
      asin: currentProduct.asin,
      title: currentProduct.title,
      priceCents: currentProduct.priceCents,
      imageUrl: currentProduct.imageUrl || undefined,
      description: currentProduct.description || undefined,
      category: categorySelect.value || undefined,
      manufacturer: currentProduct.manufacturer || undefined,
    },
  });

  importBtn.disabled = false;
  importBtn.textContent = "Import to Price Games";

  if (result?.ok) {
    showImportResult(true, result.created ? "Product created!" : "Product updated!");
  } else {
    showImportResult(false, result?.error || "Import failed");
  }
});

// Logout buttons
for (const btn of [
  document.getElementById("logout-btn-1"),
  document.getElementById("logout-btn-2"),
  document.getElementById("logout-btn-3"),
]) {
  btn?.addEventListener("click", async () => {
    await sendBackground({ type: "LOGOUT" });
    showView(loginView);
  });
}

// ─── Initialization ───

/**
 * Initialize the popup based on auth state and current tab.
 *
 * Flow:
 * 1. Check auth → not authenticated → login view
 * 2. Amazon product page → SCRAPE_PRODUCT → product view (existing flow)
 * 3. Non-Amazon page → inject content.js → DETECT_PRODUCT → generic product view → Amazon search
 * 4. No product detected → no-product view
 */
async function initialize(): Promise<void> {
  showView(loadingView);

  const authResult = await sendBackground({ type: "CHECK_AUTH" });

  if (!authResult?.authenticated) {
    showView(loginView);
    return;
  }

  // Amazon product page: use existing scrape + import flow
  if (await isAmazonProductPage()) {
    const product = await sendContentScript({ type: "SCRAPE_PRODUCT" });
    if (!product) {
      showView(noProductView);
      return;
    }
    showProductPreview(product);
    return;
  }

  // Non-Amazon page: inject content script on demand, collect structured data,
  // then run detectProduct in the popup (avoids code-splitting issues in content scripts)
  const injected = await injectContentScript();
  if (!injected) {
    showView(noProductView);
    return;
  }

  const rawData: RawStructuredData | null = await sendContentScript({ type: "DETECT_PRODUCT" });
  if (!rawData) {
    showView(noProductView);
    return;
  }

  const detected = detectProduct(rawData.jsonLdScripts, rawData.metaTags, rawData.microdataItems);

  if (!detected?.title) {
    showView(noProductView);
    return;
  }

  showGenericProductPreview(detected);
  await searchAmazon(detected);
}

initialize();
