/**
 * Content script for Amazon search result pages.
 *
 * Injected programmatically into background Amazon tabs to scrape search results.
 * Not auto-injected — loaded via chrome.scripting.executeScript from the background worker.
 */

import { scrapeSearchResults } from "./amazon-search-scraper";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message.type === "SCRAPE_AMAZON_SEARCH") {
    sendResponse(scrapeSearchResults());
  } else {
    sendResponse(null);
  }
  return true;
});
