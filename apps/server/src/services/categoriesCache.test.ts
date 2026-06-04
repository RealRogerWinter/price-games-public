import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/dbHelper";
import {
  getCategoriesWithCounts,
  getValidCategoryNames,
  invalidateCategoriesCache,
} from "./categoriesCache";
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;

function seedProducts(rows: Array<{ category: string; n: number; active?: boolean }>): void {
  // INSERT without an explicit id — let SQLite assign rowids so multiple
  // calls within a single test don't collide on the PK.
  const insert = db.prepare(
    "INSERT INTO products (title, price_cents, category, is_active, scraped_at, added_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      insert.run(
        `prod-${row.category}-${i}-${Date.now()}-${Math.random()}`,
        100,
        row.category,
        row.active === false ? 0 : 1,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
    }
  }
}

beforeEach(() => {
  db = createTestDb();
  invalidateCategoriesCache();
});

afterEach(() => {
  invalidateCategoriesCache();
});

describe("categoriesCache", () => {
  it("getValidCategoryNames returns the active distinct set", () => {
    seedProducts([
      { category: "Toys", n: 3 },
      { category: "Books", n: 2 },
      { category: "Inactive", n: 1, active: false },
    ]);
    const names = getValidCategoryNames(db);
    expect(names).toEqual(new Set(["Toys", "Books"]));
  });

  it("getCategoriesWithCounts hides categories below the minimum threshold", () => {
    // The minimum is 15 active products per category — shape the seed
    // around that boundary so both branches are exercised.
    seedProducts([
      { category: "Big", n: 20 },
      { category: "Small", n: 5 },
    ]);
    const list = getCategoriesWithCounts(db);
    expect(list).toEqual([{ name: "Big", count: 20 }]);
  });

  it("returns the SAME object reference on cache hit (proves memoization)", () => {
    seedProducts([{ category: "A", n: 16 }]);
    const a = getCategoriesWithCounts(db);
    const b = getCategoriesWithCounts(db);
    expect(b).toBe(a);
  });

  it("invalidate forces a re-read on next call", () => {
    seedProducts([{ category: "A", n: 16 }]);
    const before = getCategoriesWithCounts(db);
    expect(before).toEqual([{ name: "A", count: 16 }]);

    // Add another product post-cache without invalidating — stale read.
    seedProducts([{ category: "A", n: 1 }]);
    const stale = getCategoriesWithCounts(db);
    expect(stale).toBe(before);

    // Invalidate — fresh read.
    invalidateCategoriesCache();
    const fresh = getCategoriesWithCounts(db);
    expect(fresh).toEqual([{ name: "A", count: 17 }]);
  });
});
