import { extensionLogin, importProduct, fetchCategories, verifySession } from "./api";

interface ImportProductData { asin: string; title: string; priceCents: number; imageUrl?: string; description?: string; category?: string; manufacturer?: string; }

type Msg =
  | { type: "LOGIN"; username: string; password: string }
  | { type: "LOGOUT" }
  | { type: "CHECK_AUTH" }
  | { type: "IMPORT_PRODUCT"; data: ImportProductData }
  | { type: "FETCH_CATEGORIES" }
  | { type: "AMAZON_SEARCH"; query: string }
  | { type: "SCRAPE_AMAZON_PAGE"; url: string };

/** Check that a URL uses the https: scheme. */
function isHttpsUrl(url: string): boolean {
  return url.startsWith("https://");
}

async function getToken(): Promise<string | null> { return (await chrome.storage.local.get("token")).token || null; }
async function setAuth(token: string, user: Record<string, unknown>): Promise<void> { await chrome.storage.local.set({ token, user }); }
async function clearAuth(): Promise<void> { await chrome.storage.local.remove(["token", "user"]); }

/**
 * Wait for a tab to finish loading.
 *
 * @param tabId - The tab to wait for.
 * @param timeoutMs - Maximum time to wait before rejecting.
 */
function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("timeout"));
    }, timeoutMs);
    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Search Amazon by opening a background tab, injecting the scraper, and returning results.
 *
 * Retries scraping up to 3 times with increasing delays because Amazon search results
 * load asynchronously via JS after the page's `complete` status fires.
 *
 * @param query - The search query string.
 * @returns Object with ok/results or ok:false/fallback with searchUrl.
 */
async function handleAmazonSearch(query: string): Promise<unknown> {
  const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: searchUrl, active: false });
    if (!tab.id) return { ok: false, fallback: true, searchUrl };
    tabId = tab.id;
    // Skip waiting if the tab is already complete (e.g. cached pages)
    if (tab.status !== "complete") {
      await waitForTabLoad(tabId, 15000);
    }

    // Amazon search results render asynchronously after page "complete".
    // Wait, inject, then retry scraping with increasing delays.
    await new Promise((r) => setTimeout(r, 1500));
    await chrome.scripting.executeScript({ target: { tabId }, files: ["amazon-search-content.js"] });
    await new Promise((r) => setTimeout(r, 200));

    let results: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      results = await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_AMAZON_SEARCH" }) || [];
      if (Array.isArray(results) && results.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }

    await chrome.tabs.remove(tabId);
    tabId = undefined;
    return { ok: true, results, searchUrl };
  } catch {
    return { ok: false, fallback: true, searchUrl };
  } finally {
    if (tabId != null) {
      try { await chrome.tabs.remove(tabId); } catch { /* tab may already be closed */ }
    }
  }
}

/**
 * Open an Amazon product page in a background tab and scrape full product data.
 *
 * Injects content.js and sends SCRAPE_PRODUCT to get manufacturer, category,
 * description, and other fields that aren't available on the search results page.
 *
 * @param url - Amazon product page URL.
 * @returns Object with ok/product or ok:false/error.
 */
async function handleScrapeAmazonPage(url: string): Promise<unknown> {
  if (!url.startsWith("https://www.amazon.com/")) {
    return { ok: false, error: "Invalid URL: must be an Amazon product page" };
  }
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab.id) return { ok: false, error: "Failed to create tab" };
    tabId = tab.id;
    if (tab.status !== "complete") {
      await waitForTabLoad(tabId, 15000);
    }
    await new Promise((r) => setTimeout(r, 1500));
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await new Promise((r) => setTimeout(r, 200));
    const product = await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_PRODUCT" });
    await chrome.tabs.remove(tabId);
    tabId = undefined;
    if (product) {
      return { ok: true, product };
    }
    return { ok: false, error: "Could not scrape product data" };
  } catch {
    return { ok: false, error: "Failed to load Amazon product page" };
  } finally {
    if (tabId != null) {
      try { await chrome.tabs.remove(tabId); } catch { /* tab may already be closed */ }
    }
  }
}

chrome.runtime.onMessage.addListener((message: Msg, sender, sendResponse) => {
  // Only accept messages from our own extension (defence-in-depth)
  if (sender.id !== chrome.runtime.id) return false;
  handle(message).then(sendResponse);
  return true;
});

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case "LOGIN": try { const r = await extensionLogin(msg.username, msg.password); await setAuth(r.token, r.user as unknown as Record<string, unknown>); return { ok: true, user: r.user }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Login failed" }; }
    case "LOGOUT": await clearAuth(); return { ok: true };
    case "CHECK_AUTH": { const t = await getToken(); if (!t) return { authenticated: false }; const valid = await verifySession(t); if (!valid) { await clearAuth(); return { authenticated: false }; } return { authenticated: true, user: (await chrome.storage.local.get("user")).user }; }
    case "IMPORT_PRODUCT": { const t = await getToken(); if (!t) return { ok: false, error: "Not authenticated" }; try { return { ok: true, ...(await importProduct(t, msg.data)) }; } catch (e) { const msg2 = e instanceof Error ? e.message : "Import failed"; if (msg2.includes("401")) { await clearAuth(); return { ok: false, error: "Session expired, please log in again" }; } return { ok: false, error: msg2 }; } }
    case "FETCH_CATEGORIES": { const t = await getToken(); if (!t) return { ok: false, error: "Not authenticated" }; try { return { ok: true, categories: await fetchCategories(t) }; } catch { return { ok: false, categories: [] }; } }
    case "AMAZON_SEARCH": return handleAmazonSearch(msg.query);
    case "SCRAPE_AMAZON_PAGE": return handleScrapeAmazonPage(msg.url);
    default: return { ok: false, error: "Unknown message type" };
  }
}
