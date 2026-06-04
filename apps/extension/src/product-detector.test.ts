import { describe, it, expect } from "vitest";
import {
  extractFromJsonLd,
  extractFromOpenGraph,
  extractFromMicrodata,
  detectProduct,
  buildAmazonSearchQuery,
  type GenericProduct,
} from "./product-detector";

// ─── extractFromJsonLd ───

describe("extractFromJsonLd", () => {
  it("extracts from top-level Product", () => {
    const scripts = [JSON.stringify({
      "@type": "Product",
      name: "Sony WH-1000XM5",
      image: "https://example.com/img.jpg",
      brand: { "@type": "Brand", name: "Sony" },
      offers: { price: "349.99", priceCurrency: "USD" },
      url: "https://example.com/product",
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.title).toBe("Sony WH-1000XM5");
    expect(result.priceCents).toBe(34999);
    expect(result.currency).toBe("USD");
    expect(result.imageUrl).toBe("https://example.com/img.jpg");
    expect(result.brand).toBe("Sony");
    expect(result.url).toBe("https://example.com/product");
    expect(result.source).toBe("json-ld");
  });

  it("extracts from @graph array containing Product", () => {
    const scripts = [JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "My Store" },
        {
          "@type": "Product",
          name: "Bose QC45",
          image: ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
          brand: { name: "Bose" },
          offers: { price: "279.00", priceCurrency: "USD" },
        },
      ],
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.title).toBe("Bose QC45");
    expect(result.imageUrl).toBe("https://example.com/img1.jpg");
    expect(result.brand).toBe("Bose");
    expect(result.priceCents).toBe(27900);
  });

  it("extracts from array of objects", () => {
    const scripts = [JSON.stringify([
      { "@type": "Organization", name: "My Store" },
      {
        "@type": "Product",
        name: "AirPods Pro",
        brand: "Apple",
        offers: { price: "249.00", priceCurrency: "USD" },
      },
    ])];
    const result = extractFromJsonLd(scripts)!;
    expect(result.title).toBe("AirPods Pro");
    expect(result.brand).toBe("Apple");
    expect(result.priceCents).toBe(24900);
  });

  it("handles offers as array (takes first)", () => {
    const scripts = [JSON.stringify({
      "@type": "Product",
      name: "Multi Offer Product",
      offers: [
        { price: "99.99", priceCurrency: "USD" },
        { price: "109.99", priceCurrency: "USD" },
      ],
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.priceCents).toBe(9999);
  });

  it("handles AggregateOffer with lowPrice", () => {
    const scripts = [JSON.stringify({
      "@type": "Product",
      name: "Aggregate Product",
      offers: { "@type": "AggregateOffer", lowPrice: "49.99", priceCurrency: "USD" },
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.priceCents).toBe(4999);
  });

  it("returns product with null price when offers missing", () => {
    const scripts = [JSON.stringify({
      "@type": "Product",
      name: "No Price Product",
      image: "https://example.com/img.jpg",
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.title).toBe("No Price Product");
    expect(result.priceCents).toBeNull();
  });

  it("returns product with null image when image missing", () => {
    const scripts = [JSON.stringify({
      "@type": "Product",
      name: "No Image Product",
      offers: { price: "19.99" },
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.title).toBe("No Image Product");
    expect(result.imageUrl).toBeNull();
  });

  it("returns null for non-Product JSON-LD", () => {
    const scripts = [JSON.stringify({ "@type": "Organization", name: "My Store" })];
    expect(extractFromJsonLd(scripts)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(extractFromJsonLd(["not valid json {"])).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(extractFromJsonLd([])).toBeNull();
  });

  it("returns null when Product has no name", () => {
    const scripts = [JSON.stringify({ "@type": "Product", image: "https://example.com/img.jpg" })];
    expect(extractFromJsonLd(scripts)).toBeNull();
  });

  it("rejects non-https image URLs (javascript:, data:)", () => {
    const scripts = [JSON.stringify({
      "@type": "Product",
      name: "Unsafe Image Product",
      image: "javascript:alert(1)",
      offers: { price: "29.99" },
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.title).toBe("Unsafe Image Product");
    expect(result.imageUrl).toBeNull();
  });

  it("parses price range by taking first price", () => {
    const scripts = [JSON.stringify({
      "@type": "Product",
      name: "Range Price Product",
      offers: { price: "$12.99 - $19.99" },
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.priceCents).toBe(1299);
  });

  it("caps brand length to 200 characters", () => {
    const longBrand = "A".repeat(300);
    const scripts = [JSON.stringify({
      "@type": "Product",
      name: "Long Brand Product",
      brand: longBrand,
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.brand!.length).toBe(200);
  });

  it("caps currency length to 10 characters", () => {
    const scripts = [JSON.stringify({
      "@type": "Product",
      name: "Long Currency Product",
      offers: { price: "9.99", priceCurrency: "VERYLONGCURRENCYNAME" },
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.currency!.length).toBeLessThanOrEqual(10);
  });

  it("handles @type as array including Product", () => {
    const scripts = [JSON.stringify({
      "@type": ["Product", "IndividualProduct"],
      name: "Multi-type Product",
      offers: { price: "59.99" },
    })];
    const result = extractFromJsonLd(scripts)!;
    expect(result.title).toBe("Multi-type Product");
    expect(result.priceCents).toBe(5999);
  });

  it("tries multiple scripts and finds Product in second", () => {
    const scripts = [
      JSON.stringify({ "@type": "WebSite", name: "Store" }),
      JSON.stringify({ "@type": "Product", name: "Found Product", offers: { price: "29.99" } }),
    ];
    const result = extractFromJsonLd(scripts)!;
    expect(result.title).toBe("Found Product");
  });
});

// ─── extractFromOpenGraph ───

describe("extractFromOpenGraph", () => {
  it("extracts full product OG tags", () => {
    const tags = [
      { property: "og:title", content: "Sony WH-1000XM5 Headphones" },
      { property: "og:image", content: "https://example.com/og-img.jpg" },
      { property: "og:url", content: "https://example.com/product" },
      { property: "og:price:amount", content: "349.99" },
      { property: "og:price:currency", content: "USD" },
      { property: "product:brand", content: "Sony" },
    ];
    const result = extractFromOpenGraph(tags)!;
    expect(result.title).toBe("Sony WH-1000XM5 Headphones");
    expect(result.priceCents).toBe(34999);
    expect(result.currency).toBe("USD");
    expect(result.imageUrl).toBe("https://example.com/og-img.jpg");
    expect(result.brand).toBe("Sony");
    expect(result.url).toBe("https://example.com/product");
    expect(result.source).toBe("opengraph");
  });

  it("extracts with product:price:amount variant", () => {
    const tags = [
      { property: "og:title", content: "Some Product" },
      { property: "product:price:amount", content: "199.99" },
      { property: "product:price:currency", content: "USD" },
    ];
    const result = extractFromOpenGraph(tags)!;
    expect(result.priceCents).toBe(19999);
    expect(result.currency).toBe("USD");
  });

  it("returns result with minimal tags (title + image only)", () => {
    const tags = [
      { property: "og:title", content: "Minimal Product" },
      { property: "og:image", content: "https://example.com/img.jpg" },
    ];
    const result = extractFromOpenGraph(tags)!;
    expect(result.title).toBe("Minimal Product");
    expect(result.imageUrl).toBe("https://example.com/img.jpg");
    expect(result.priceCents).toBeNull();
    expect(result.brand).toBeNull();
  });

  it("returns null when og:title is missing", () => {
    const tags = [
      { property: "og:image", content: "https://example.com/img.jpg" },
      { property: "og:price:amount", content: "29.99" },
    ];
    expect(extractFromOpenGraph(tags)).toBeNull();
  });

  it("returns null for empty tags array", () => {
    expect(extractFromOpenGraph([])).toBeNull();
  });
});

// ─── extractFromMicrodata ───

describe("extractFromMicrodata", () => {
  it("extracts from Product microdata", () => {
    const items = [{
      type: "https://schema.org/Product",
      properties: {
        name: "Microdata Product",
        price: "79.99",
        image: "https://example.com/micro-img.jpg",
        brand: "TestBrand",
      },
    }];
    const result = extractFromMicrodata(items)!;
    expect(result.title).toBe("Microdata Product");
    expect(result.priceCents).toBe(7999);
    expect(result.imageUrl).toBe("https://example.com/micro-img.jpg");
    expect(result.brand).toBe("TestBrand");
    expect(result.source).toBe("microdata");
  });

  it("handles Product among other types", () => {
    const items = [
      { type: "https://schema.org/Organization", properties: { name: "Org" } },
      { type: "https://schema.org/Product", properties: { name: "Found It", price: "49.99" } },
    ];
    const result = extractFromMicrodata(items)!;
    expect(result.title).toBe("Found It");
    expect(result.priceCents).toBe(4999);
  });

  it("returns null when no Product type", () => {
    const items = [{ type: "https://schema.org/Organization", properties: { name: "Org" } }];
    expect(extractFromMicrodata(items)).toBeNull();
  });

  it("returns null for empty items", () => {
    expect(extractFromMicrodata([])).toBeNull();
  });

  it("returns null when Product has no name", () => {
    const items = [{ type: "https://schema.org/Product", properties: { price: "29.99" } }];
    expect(extractFromMicrodata(items)).toBeNull();
  });
});

// ─── detectProduct ───

describe("detectProduct", () => {
  const jsonLdScripts = [JSON.stringify({ "@type": "Product", name: "JSON-LD Product", offers: { price: "99.99" } })];
  const ogTags = [{ property: "og:title", content: "OG Product" }];
  const microItems = [{ type: "https://schema.org/Product", properties: { name: "Micro Product", price: "49.99" } }];

  it("prefers JSON-LD over Open Graph and microdata", () => {
    const result = detectProduct(jsonLdScripts, ogTags, microItems)!;
    expect(result.title).toBe("JSON-LD Product");
    expect(result.source).toBe("json-ld");
  });

  it("falls back to Open Graph when no JSON-LD Product", () => {
    const result = detectProduct([], ogTags, microItems)!;
    expect(result.title).toBe("OG Product");
    expect(result.source).toBe("opengraph");
  });

  it("falls back to microdata when no JSON-LD or OG", () => {
    const result = detectProduct([], [], microItems)!;
    expect(result.title).toBe("Micro Product");
    expect(result.source).toBe("microdata");
  });

  it("returns null when nothing found", () => {
    expect(detectProduct([], [], [])).toBeNull();
  });
});

// ─── buildAmazonSearchQuery ───

describe("buildAmazonSearchQuery", () => {
  it("combines brand + title when brand not in title", () => {
    const p: GenericProduct = { title: "WH-1000XM5 Headphones", brand: "Sony", priceCents: null, currency: null, imageUrl: null, url: null, source: null };
    expect(buildAmazonSearchQuery(p)).toBe("Sony WH-1000XM5 Headphones");
  });

  it("does not duplicate brand when already in title", () => {
    const p: GenericProduct = { title: "Sony WH-1000XM5 Headphones", brand: "Sony", priceCents: null, currency: null, imageUrl: null, url: null, source: null };
    expect(buildAmazonSearchQuery(p)).toBe("Sony WH-1000XM5 Headphones");
  });

  it("truncates long titles to ~8 words", () => {
    const p: GenericProduct = { title: "Super Amazing Ultra Premium Deluxe Mega Turbo Extreme Wireless Bluetooth Headphones Model X", brand: null, priceCents: null, currency: null, imageUrl: null, url: null, source: null };
    const result = buildAmazonSearchQuery(p);
    const wordCount = result.split(/\s+/).length;
    expect(wordCount).toBeLessThanOrEqual(8);
  });

  it("strips noise words", () => {
    const p: GenericProduct = { title: "Buy Official Sony Headphones Free Shipping", brand: null, priceCents: null, currency: null, imageUrl: null, url: null, source: null };
    const result = buildAmazonSearchQuery(p);
    expect(result.toLowerCase()).not.toContain("buy");
    expect(result.toLowerCase()).not.toContain("official");
    expect(result.toLowerCase()).not.toContain("free");
    expect(result.toLowerCase()).not.toContain("shipping");
    expect(result).toContain("Sony");
    expect(result).toContain("Headphones");
  });

  it("strips special characters", () => {
    const p: GenericProduct = { title: "Sony™ WH-1000XM5 (2024) — Headphones!", brand: null, priceCents: null, currency: null, imageUrl: null, url: null, source: null };
    const result = buildAmazonSearchQuery(p);
    expect(result).not.toContain("™");
    expect(result).not.toContain("!");
    expect(result).not.toContain("—");
    expect(result).toContain("Sony");
    expect(result).toContain("WH-1000XM5");
  });

  it("returns empty string for null title", () => {
    const p: GenericProduct = { title: null, brand: null, priceCents: null, currency: null, imageUrl: null, url: null, source: null };
    expect(buildAmazonSearchQuery(p)).toBe("");
  });

  it("truncates to max 80 characters", () => {
    const p: GenericProduct = { title: "Abcdefghij Abcdefghij Abcdefghij Abcdefghij Abcdefghij Abcdefghij Abcdefghij Abcdefghij", brand: null, priceCents: null, currency: null, imageUrl: null, url: null, source: null };
    expect(buildAmazonSearchQuery(p).length).toBeLessThanOrEqual(80);
  });
});
