import { describe, it, expect } from "vitest";
import {
  extractAsinFromUrl,
  parsePriceToCents,
  cleanTitle,
  cleanManufacturer,
  mapBreadcrumbsToCategory,
  upgradeImageUrl,
} from "./scraper";

describe("extractAsinFromUrl", () => {
  it("extracts ASIN from /dp/ URL", () => {
    expect(extractAsinFromUrl("https://www.amazon.com/dp/B0TESTTEST")).toBe("B0TESTTEST");
  });
  it("extracts ASIN from /*/dp/ URL with product slug", () => {
    expect(extractAsinFromUrl("https://www.amazon.com/Sony-WH-1000XM5/dp/B09XS7JWHH/ref=sr_1_1")).toBe("B09XS7JWHH");
  });
  it("extracts ASIN from /gp/product/ URL", () => {
    expect(extractAsinFromUrl("https://www.amazon.com/gp/product/B0D1XD1ZV3?th=1")).toBe("B0D1XD1ZV3");
  });
  it("extracts ASIN from URL with query params", () => {
    expect(extractAsinFromUrl("https://www.amazon.com/dp/B0TESTTEST?ref=pd_sl_1")).toBe("B0TESTTEST");
  });
  it("returns null for non-Amazon product URL", () => {
    expect(extractAsinFromUrl("https://www.amazon.com/s?k=headphones")).toBeNull();
  });
  it("returns null for malformed URL", () => {
    expect(extractAsinFromUrl("not a url")).toBeNull();
  });
});

describe("parsePriceToCents", () => {
  it("parses standard price", () => { expect(parsePriceToCents("$29.99")).toBe(2999); });
  it("parses price with comma thousands separator", () => { expect(parsePriceToCents("$1,299.99")).toBe(129999); });
  it("returns null for price below $1", () => { expect(parsePriceToCents("$0.99")).toBeNull(); });
  it("returns null for price above $10,000", () => { expect(parsePriceToCents("$10,001.00")).toBeNull(); });
  it("parses integer price", () => { expect(parsePriceToCents("$100")).toBe(10000); });
});

describe("cleanTitle", () => {
  it("trims whitespace", () => { expect(cleanTitle("  Sony Headphones  ")).toBe("Sony Headphones"); });
  it("decodes HTML entities", () => { expect(cleanTitle("Tom &amp; Jerry")).toBe("Tom & Jerry"); });
  it("decodes quotes", () => { expect(cleanTitle("6&quot; Screen")).toBe('6" Screen'); });
});

describe("cleanManufacturer", () => {
  it("strips 'Visit the...Store' pattern", () => { expect(cleanManufacturer("Visit the Sony Store")).toBe("Sony"); });
  it("strips 'Brand:' prefix", () => { expect(cleanManufacturer("Brand: Sony")).toBe("Sony"); });
  it("handles already clean names", () => { expect(cleanManufacturer("Sony")).toBe("Sony"); });
  it("trims whitespace", () => { expect(cleanManufacturer("  Sony  ")).toBe("Sony"); });
});

describe("mapBreadcrumbsToCategory", () => {
  it("maps Electronics breadcrumb", () => { expect(mapBreadcrumbsToCategory(["Electronics", "Headphones"])).toBe("Electronics"); });
  it("maps nested breadcrumb", () => { expect(mapBreadcrumbsToCategory(["Home & Kitchen", "Kitchen Gadgets"])).toBe("Home & Kitchen"); });
  it("returns null for unknown breadcrumbs", () => { expect(mapBreadcrumbsToCategory(["Unknown Category"])).toBeNull(); });
});

describe("upgradeImageUrl", () => {
  it("upgrades image URL to high resolution", () => {
    expect(upgradeImageUrl("https://m.media-amazon.com/images/I/test._AC_SL300_.jpg")).toBe("https://m.media-amazon.com/images/I/test._AC_SL1500_.jpg");
  });
  it("leaves URLs without size pattern unchanged", () => {
    expect(upgradeImageUrl("https://m.media-amazon.com/images/I/test.jpg")).toBe("https://m.media-amazon.com/images/I/test.jpg");
  });
});
