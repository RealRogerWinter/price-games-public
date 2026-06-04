/**
 * Tests for the admin product management service.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedProducts, seedDiverseProducts } from "../test/dbHelper";
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  setProductActive,
  bulkSetProductActive,
  setProductArchived,
  bulkSetProductArchived,
  getProductCategories,
} from "./adminProducts";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

describe("listProducts", () => {
  it("returns paginated products with defaults", () => {
    seedProducts(db, 10);
    const result = listProducts(db, {});
    expect(result.products).toHaveLength(10);
    expect(result.total).toBe(10);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
    expect(result.totalPages).toBe(1);
  });

  it("paginates correctly", () => {
    seedProducts(db, 25);
    const page1 = listProducts(db, { page: 1, pageSize: 10 });
    expect(page1.products).toHaveLength(10);
    expect(page1.total).toBe(25);
    expect(page1.totalPages).toBe(3);

    const page3 = listProducts(db, { page: 3, pageSize: 10 });
    expect(page3.products).toHaveLength(5);
  });

  it("clamps page and pageSize to valid ranges", () => {
    seedProducts(db, 5);
    const result = listProducts(db, { page: -1, pageSize: 0 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(1);

    const big = listProducts(db, { pageSize: 999 });
    expect(big.pageSize).toBe(200);
  });

  it("searches across title, manufacturer, and asin", () => {
    seedDiverseProducts(db, 16);
    const byTitle = listProducts(db, { search: "Bluetooth" });
    expect(byTitle.products.length).toBeGreaterThan(0);
    expect(byTitle.products[0].title).toContain("Bluetooth");

    const byMfg = listProducts(db, { search: "Sony" });
    expect(byMfg.products.length).toBeGreaterThan(0);
    expect(byMfg.products[0].manufacturer).toBe("Sony");
  });

  it("filters by category", () => {
    seedDiverseProducts(db, 16);
    const result = listProducts(db, { category: "Electronics" });
    expect(result.products.length).toBeGreaterThan(0);
    for (const p of result.products) {
      expect(p.category).toBe("Electronics");
    }
  });

  it("filters by isActive", () => {
    seedProducts(db, 5);
    // Deactivate one product
    db.prepare("UPDATE products SET is_active = 0 WHERE id = 1").run();

    const active = listProducts(db, { isActive: true });
    expect(active.total).toBe(4);

    const inactive = listProducts(db, { isActive: false });
    expect(inactive.total).toBe(1);
  });

  it("filters by isArchived", () => {
    seedProducts(db, 5);
    // Archive two products
    db.prepare("UPDATE products SET is_archived = 1, is_active = 0 WHERE id IN (1, 2)").run();

    const notArchived = listProducts(db, { isArchived: false });
    expect(notArchived.total).toBe(3);

    const archived = listProducts(db, { isArchived: true });
    expect(archived.total).toBe(2);

    // No filter returns all
    const all = listProducts(db, {});
    expect(all.total).toBe(5);
  });

  it("sorts by different columns", () => {
    seedDiverseProducts(db, 16);

    const byTitleAsc = listProducts(db, { sortBy: "title", sortOrder: "asc" });
    const titles = byTitleAsc.products.map((p) => p.title);
    expect(titles).toEqual([...titles].sort());

    const byTitleDesc = listProducts(db, { sortBy: "title", sortOrder: "desc" });
    const titlesDesc = byTitleDesc.products.map((p) => p.title);
    expect(titlesDesc).toEqual([...titlesDesc].sort().reverse());
  });

  it("sorts by price", () => {
    seedDiverseProducts(db, 16);
    const byPrice = listProducts(db, { sortBy: "priceCents", sortOrder: "asc" });
    const prices = byPrice.products.map((p) => p.priceCents);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
    }
  });

  it("returns empty result for no matches", () => {
    seedProducts(db, 5);
    const result = listProducts(db, { search: "nonexistentthing" });
    expect(result.products).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
  });
});

describe("getProduct", () => {
  it("returns a product by id", () => {
    seedProducts(db, 3);
    const product = getProduct(db, 1);
    expect(product).not.toBeNull();
    expect(product!.id).toBe(1);
    expect(product!.title).toBeDefined();
  });

  it("returns null for non-existent product", () => {
    const product = getProduct(db, 999);
    expect(product).toBeNull();
  });
});

describe("createProduct", () => {
  it("creates a product with required fields", () => {
    const product = createProduct(db, {
      title: "Test Widget",
      priceCents: 1999,
    });
    expect(product.id).toBeDefined();
    expect(product.title).toBe("Test Widget");
    expect(product.priceCents).toBe(1999);
    expect(product.isActive).toBe(true);
    expect(product.addedAt).toBeDefined();
  });

  it("creates a product with all optional fields", () => {
    const product = createProduct(db, {
      title: "Full Widget",
      priceCents: 5999,
      asin: "B0TESTTEST",
      imageUrl: "https://example.com/img.jpg",
      description: "A full product",
      category: "Electronics",
      manufacturer: "TestCo",
      isActive: false,
    });
    expect(product.asin).toBe("B0TESTTEST");
    expect(product.imageUrl).toBe("https://example.com/img.jpg");
    expect(product.category).toBe("Electronics");
    expect(product.manufacturer).toBe("TestCo");
    expect(product.isActive).toBe(false);
  });

  it("throws on missing title", () => {
    expect(() => createProduct(db, { title: "", priceCents: 100 })).toThrow("Title is required");
  });

  it("throws on negative price", () => {
    expect(() => createProduct(db, { title: "Test", priceCents: -1 })).toThrow(
      "Price must be a non-negative number"
    );
  });

  it("trims title whitespace", () => {
    const product = createProduct(db, { title: "  Trimmed Widget  ", priceCents: 100 });
    expect(product.title).toBe("Trimmed Widget");
  });
});

describe("updateProduct", () => {
  it("updates specified fields only", () => {
    seedProducts(db, 1, { category: "Electronics" });
    const updated = updateProduct(db, 1, { title: "Updated Title" });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated Title");
    expect(updated!.category).toBe("Electronics");
  });

  it("updates price", () => {
    seedProducts(db, 1);
    const updated = updateProduct(db, 1, { priceCents: 9999 });
    expect(updated!.priceCents).toBe(9999);
  });

  it("updates multiple fields at once", () => {
    seedProducts(db, 1);
    const updated = updateProduct(db, 1, {
      title: "New Title",
      category: "Home & Kitchen",
      manufacturer: "NewCo",
    });
    expect(updated!.title).toBe("New Title");
    expect(updated!.category).toBe("Home & Kitchen");
    expect(updated!.manufacturer).toBe("NewCo");
  });

  it("returns null for non-existent product", () => {
    const result = updateProduct(db, 999, { title: "Nope" });
    expect(result).toBeNull();
  });

  it("returns existing product if no fields provided", () => {
    seedProducts(db, 1);
    const original = getProduct(db, 1);
    const result = updateProduct(db, 1, {});
    expect(result!.title).toBe(original!.title);
  });

  it("throws on empty title", () => {
    seedProducts(db, 1);
    expect(() => updateProduct(db, 1, { title: "" })).toThrow("Title cannot be empty");
  });

  it("throws on negative price", () => {
    seedProducts(db, 1);
    expect(() => updateProduct(db, 1, { priceCents: -5 })).toThrow(
      "Price must be a non-negative number"
    );
  });
});

describe("setProductActive", () => {
  it("deactivates a product", () => {
    seedProducts(db, 1);
    const result = setProductActive(db, 1, false);
    expect(result).not.toBeNull();
    expect(result!.isActive).toBe(false);
  });

  it("activates a product", () => {
    seedProducts(db, 1);
    db.prepare("UPDATE products SET is_active = 0 WHERE id = 1").run();
    const result = setProductActive(db, 1, true);
    expect(result!.isActive).toBe(true);
  });

  it("returns null for non-existent product", () => {
    const result = setProductActive(db, 999, true);
    expect(result).toBeNull();
  });
});

describe("bulkSetProductActive", () => {
  it("activates multiple products", () => {
    seedProducts(db, 5);
    // Deactivate first
    setProductActive(db, 1, false);
    setProductActive(db, 2, false);
    const updated = bulkSetProductActive(db, [1, 2], true);
    expect(updated).toBe(2);
    expect(getProduct(db, 1)!.isActive).toBe(true);
    expect(getProduct(db, 2)!.isActive).toBe(true);
  });

  it("deactivates multiple products", () => {
    seedProducts(db, 3);
    const updated = bulkSetProductActive(db, [1, 2, 3], false);
    expect(updated).toBe(3);
    expect(getProduct(db, 1)!.isActive).toBe(false);
    expect(getProduct(db, 2)!.isActive).toBe(false);
    expect(getProduct(db, 3)!.isActive).toBe(false);
  });

  it("returns 0 for empty array", () => {
    expect(bulkSetProductActive(db, [], true)).toBe(0);
  });

  it("handles non-existent IDs gracefully", () => {
    seedProducts(db, 2);
    const updated = bulkSetProductActive(db, [1, 999, 1000], true);
    expect(updated).toBe(1);
  });

  it("handles duplicate IDs", () => {
    seedProducts(db, 2);
    setProductActive(db, 1, false);
    const updated = bulkSetProductActive(db, [1, 1], true);
    expect(updated).toBe(1);
    expect(getProduct(db, 1)!.isActive).toBe(true);
  });
});

describe("setProductArchived", () => {
  it("archives a product and deactivates it", () => {
    seedProducts(db, 1);
    const result = setProductArchived(db, 1, true);
    expect(result).not.toBeNull();
    expect(result!.isArchived).toBe(true);
    expect(result!.isActive).toBe(false);
  });

  it("unarchives a product but leaves it inactive", () => {
    seedProducts(db, 1);
    setProductArchived(db, 1, true);
    const result = setProductArchived(db, 1, false);
    expect(result).not.toBeNull();
    expect(result!.isArchived).toBe(false);
    expect(result!.isActive).toBe(false);
  });

  it("returns null for non-existent product", () => {
    const result = setProductArchived(db, 999, true);
    expect(result).toBeNull();
  });
});

describe("bulkSetProductArchived", () => {
  it("archives multiple products and deactivates them", () => {
    seedProducts(db, 5);
    const updated = bulkSetProductArchived(db, [1, 2, 3], true);
    expect(updated).toBe(3);
    expect(getProduct(db, 1)!.isArchived).toBe(true);
    expect(getProduct(db, 1)!.isActive).toBe(false);
    expect(getProduct(db, 2)!.isArchived).toBe(true);
    expect(getProduct(db, 3)!.isArchived).toBe(true);
    // Unaffected products stay active and non-archived
    expect(getProduct(db, 4)!.isArchived).toBe(false);
    expect(getProduct(db, 4)!.isActive).toBe(true);
  });

  it("unarchives multiple products but leaves them inactive", () => {
    seedProducts(db, 3);
    bulkSetProductArchived(db, [1, 2, 3], true);
    const updated = bulkSetProductArchived(db, [1, 2], false);
    expect(updated).toBe(2);
    expect(getProduct(db, 1)!.isArchived).toBe(false);
    expect(getProduct(db, 1)!.isActive).toBe(false);
    expect(getProduct(db, 2)!.isArchived).toBe(false);
    // Product 3 still archived
    expect(getProduct(db, 3)!.isArchived).toBe(true);
  });

  it("returns 0 for empty array", () => {
    expect(bulkSetProductArchived(db, [], true)).toBe(0);
  });

  it("handles non-existent IDs gracefully", () => {
    seedProducts(db, 2);
    const updated = bulkSetProductArchived(db, [1, 999, 1000], true);
    expect(updated).toBe(1);
  });
});

describe("setProductActive clears archive flag", () => {
  it("activating an archived product clears is_archived", () => {
    seedProducts(db, 1);
    setProductArchived(db, 1, true);
    expect(getProduct(db, 1)!.isArchived).toBe(true);
    expect(getProduct(db, 1)!.isActive).toBe(false);

    const result = setProductActive(db, 1, true);
    expect(result!.isActive).toBe(true);
    expect(result!.isArchived).toBe(false);
  });
});

describe("getProductCategories", () => {
  it("returns distinct categories", () => {
    seedDiverseProducts(db, 16);
    const categories = getProductCategories(db);
    expect(categories.length).toBeGreaterThan(1);
    // Should be sorted
    expect(categories).toEqual([...categories].sort());
    // Should be unique
    expect(new Set(categories).size).toBe(categories.length);
  });

  it("returns empty array when no products", () => {
    const categories = getProductCategories(db);
    expect(categories).toEqual([]);
  });
});
