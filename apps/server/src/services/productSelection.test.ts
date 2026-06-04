import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedProducts } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

let testDb: DatabaseType;

vi.mock("../db", () => {
  return {
    default: null as any,
  };
});

beforeEach(async () => {
  testDb = createTestDb();
  seedProducts(testDb, 50);

  const mod = await import("../db");
  (mod as any).default = testDb;
});

// Must import after mock is set up
const { selectProducts, ensureComparisonPairsDistinct } = await import("./productSelection");

describe("selectProducts", () => {
  it("returns the requested number of products", () => {
    const products = selectProducts(10);
    expect(products).toHaveLength(10);
  });

  it("returns products with id and price_cents", () => {
    const products = selectProducts(5);
    for (const p of products) {
      expect(p.id).toBeDefined();
      expect(typeof p.id).toBe("number");
      expect(p.price_cents).toBeDefined();
      expect(typeof p.price_cents).toBe("number");
    }
  });

  it("returns unique products", () => {
    const products = selectProducts(20);
    const ids = products.map((p) => p.id);
    expect(new Set(ids).size).toBe(20);
  });

  it("throws when not enough products available", () => {
    expect(() => selectProducts(100)).toThrow("Not enough active products");
  });

  it("filters by category", () => {
    // Add products in a different category
    const insert = testDb.prepare(
      "INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)"
    );
    for (let i = 0; i < 5; i++) {
      insert.run(`SPORTS${i}`, `Sport Product ${i}`, "", "", 1000 + i * 100, "Sports & Outdoors");
    }

    const products = selectProducts(5, ["Sports & Outdoors"]);
    expect(products).toHaveLength(5);
  });

  it("marks selected products as recently used (last_used_at)", () => {
    const products = selectProducts(5);
    for (const p of products) {
      const row = testDb.prepare("SELECT last_used_at FROM products WHERE id = ?").get(p.id) as any;
      expect(row.last_used_at).toBeDefined();
      expect(row.last_used_at).not.toBeNull();
    }
  });
});

describe("ensureComparisonPairsDistinct", () => {
  it("returns products unchanged if pairs already have different prices", () => {
    const products = [
      { id: 1, price_cents: 1000 },
      { id: 2, price_cents: 2000 },
      { id: 3, price_cents: 3000 },
      { id: 4, price_cents: 4000 },
    ];
    const result = ensureComparisonPairsDistinct(products, 2);
    expect(result).toHaveLength(4);
    // Pairs should still have different prices
    expect(result[0].price_cents).not.toBe(result[1].price_cents);
    expect(result[2].price_cents).not.toBe(result[3].price_cents);
  });

  it("handles empty products array", () => {
    const result = ensureComparisonPairsDistinct([], 2);
    expect(result).toHaveLength(0);
  });

  it("handles single product", () => {
    const result = ensureComparisonPairsDistinct([{ id: 1, price_cents: 1000 }], 2);
    expect(result).toHaveLength(1);
  });

  it("replaces product in pair when both have same price", () => {
    // Seed products with a specific price and one with a different price
    testDb.prepare("DELETE FROM products").run();
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(101, "A1", "Product A", "", "", 5000, "Electronics");
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(102, "A2", "Product B", "", "", 5000, "Electronics");
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(103, "A3", "Product C", "", "", 3000, "Electronics");

    const samePricePair = [
      { id: 101, price_cents: 5000 },
      { id: 102, price_cents: 5000 },
    ];

    const result = ensureComparisonPairsDistinct(samePricePair, 2);
    expect(result).toHaveLength(2);
    // Second product should have been replaced with one that has different price
    expect(result[0].price_cents === result[1].price_cents).toBe(false);
  });

  it("works with category filter", () => {
    testDb.prepare("DELETE FROM products").run();
    for (let i = 0; i < 10; i++) {
      testDb.prepare(
        "INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)"
      ).run(`CAT${i}`, `Cat Product ${i}`, "", "", 1000 + i * 500, "Toys & Games");
    }

    const products = selectProducts(5, ["Toys & Games"]);
    expect(products).toHaveLength(5);
  });

  it("replaces same-price pair using category-filtered findProductWithDifferentPrice", () => {
    testDb.prepare("DELETE FROM products").run();
    // Two same-price products in "Books" and one different-price in "Books"
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(201, "B1", "Book A", "", "", 4000, "Books");
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(202, "B2", "Book B", "", "", 4000, "Books");
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(203, "B3", "Book C", "", "", 2000, "Books");

    const samePricePair = [
      { id: 201, price_cents: 4000 },
      { id: 202, price_cents: 4000 },
    ];

    const result = ensureComparisonPairsDistinct(samePricePair, 2, ["Books"]);
    expect(result).toHaveLength(2);
    expect(result[0].price_cents !== result[1].price_cents).toBe(true);
  });

  it("handles no replacement found (all products have same price)", () => {
    testDb.prepare("DELETE FROM products").run();
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(301, "S1", "Same A", "", "", 5000, "Electronics");
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(302, "S2", "Same B", "", "", 5000, "Electronics");

    const pair = [
      { id: 301, price_cents: 5000 },
      { id: 302, price_cents: 5000 },
    ];

    // No replacement available, pair stays unchanged
    const result = ensureComparisonPairsDistinct(pair, 2);
    expect(result).toHaveLength(2);
  });

  it("selectProducts with empty categories array selects from all", () => {
    const products = selectProducts(5, []);
    expect(products).toHaveLength(5);
  });
});
