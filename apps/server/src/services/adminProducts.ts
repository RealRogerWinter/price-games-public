/**
 * Admin product management service.
 *
 * Provides CRUD operations and listing with pagination, search, filtering,
 * and sorting for the admin products dashboard.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type {
  AdminProduct,
  AdminProductListParams,
  AdminProductListResponse,
  AdminProductCreateRequest,
  AdminProductUpdateRequest,
  ExtensionImportRequest,
} from "@price-game/shared";
import { invalidateCategoriesCache } from "./categoriesCache";

/** Maximum field lengths for input validation. */
const MAX_LENGTHS: Record<string, number> = {
  title: 500,
  asin: 32,
  imageUrl: 2048,
  description: 8192,
  category: 200,
  manufacturer: 500,
};

/**
 * Validate that a string field does not exceed its maximum length.
 *
 * @param field - Field name.
 * @param value - Field value.
 * @throws If the value exceeds the maximum length.
 */
function validateFieldLength(field: string, value: unknown): void {
  if (typeof value === "string" && MAX_LENGTHS[field] && value.length > MAX_LENGTHS[field]) {
    throw new Error(`${field} exceeds maximum length of ${MAX_LENGTHS[field]} characters`);
  }
}

/** Valid column names that can be used for sorting. */
const VALID_SORT_COLUMNS: Record<string, string> = {
  id: "id",
  title: "title",
  priceCents: "price_cents",
  category: "category",
  manufacturer: "manufacturer",
  addedAt: "added_at",
};

/**
 * Map a database row to an AdminProduct object.
 *
 * @param row - Raw database row.
 * @returns Mapped AdminProduct.
 */
function toAdminProduct(row: Record<string, unknown>): AdminProduct {
  return {
    id: row.id as number,
    asin: (row.asin as string) ?? null,
    title: row.title as string,
    imageUrl: (row.image_url as string) ?? null,
    description: (row.description as string) ?? null,
    priceCents: row.price_cents as number,
    category: (row.category as string) ?? null,
    isActive: row.is_active === 1 || row.is_active === true,
    isArchived: row.is_archived === 1 || row.is_archived === true,
    manufacturer: (row.manufacturer as string) ?? null,
    lastUsedAt: (row.last_used_at as string) ?? null,
    scrapedAt: (row.scraped_at as string) ?? null,
    addedAt: (row.added_at as string) ?? null,
    verified: row.verified === 1 || row.verified === true,
  };
}

/**
 * List products with pagination, search, filtering, and sorting.
 *
 * @param db - Database instance.
 * @param params - Query parameters for filtering, sorting, and pagination.
 * @returns Paginated product list with total count.
 */
export function listProducts(
  db: DatabaseType,
  params: AdminProductListParams
): AdminProductListResponse {
  const page = Math.max(params.page ?? 1, 1);
  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 200);
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (params.search) {
    conditions.push("(title LIKE ? ESCAPE '\\' OR manufacturer LIKE ? ESCAPE '\\' OR asin LIKE ? ESCAPE '\\')");
    const escaped = params.search.replace(/[%_\\]/g, "\\$&");
    const term = `%${escaped}%`;
    bindings.push(term, term, term);
  }

  if (params.category) {
    conditions.push("category = ?");
    bindings.push(params.category);
  }

  if (params.isActive !== undefined) {
    conditions.push("is_active = ?");
    bindings.push(params.isActive ? 1 : 0);
  }

  if (params.isArchived !== undefined) {
    conditions.push("is_archived = ?");
    bindings.push(params.isArchived ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sortCol = VALID_SORT_COLUMNS[params.sortBy ?? "id"] ?? "id";
  const sortOrder = params.sortOrder === "desc" ? "DESC" : "ASC";

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM products ${whereClause}`)
    .get(...bindings) as { total: number };
  const total = countRow.total;

  const rows = db
    .prepare(
      `SELECT * FROM products ${whereClause} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`
    )
    .all(...bindings, pageSize, offset) as Record<string, unknown>[];

  return {
    products: rows.map(toAdminProduct),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * Get a single product by ID.
 *
 * @param db - Database instance.
 * @param id - Product ID.
 * @returns The product, or null if not found.
 */
export function getProduct(db: DatabaseType, id: number): AdminProduct | null {
  const row = db
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? toAdminProduct(row) : null;
}

/**
 * Create a new product.
 *
 * @param db - Database instance.
 * @param data - Product creation data.
 * @returns The created product.
 * @throws If required fields are missing or invalid.
 */
export function createProduct(
  db: DatabaseType,
  data: AdminProductCreateRequest
): AdminProduct {
  if (!data.title || typeof data.title !== "string" || data.title.trim().length === 0) {
    throw new Error("Title is required");
  }
  if (data.priceCents === undefined || typeof data.priceCents !== "number" || data.priceCents < 0) {
    throw new Error("Price must be a non-negative number");
  }
  if (data.priceCents > 100_000_000 || !Number.isSafeInteger(data.priceCents)) {
    throw new Error("Price exceeds maximum allowed value");
  }

  for (const field of ["title", "asin", "imageUrl", "description", "category", "manufacturer"] as const) {
    if (data[field] !== undefined) validateFieldLength(field, data[field]);
  }
  if (data.imageUrl && !/^https?:\/\//i.test(data.imageUrl)) {
    throw new Error("imageUrl must be an HTTP or HTTPS URL");
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO products (title, price_cents, asin, image_url, description, category, manufacturer, is_active, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.title.trim(),
      data.priceCents,
      data.asin ?? null,
      data.imageUrl ?? null,
      data.description ?? null,
      data.category ?? null,
      data.manufacturer ?? null,
      data.isActive === false ? 0 : 1,
      now
    );

  invalidateCategoriesCache();
  return getProduct(db, result.lastInsertRowid as number)!;
}

/**
 * Update an existing product's fields.
 *
 * @param db - Database instance.
 * @param id - Product ID.
 * @param data - Partial update data.
 * @returns The updated product, or null if not found.
 */
export function updateProduct(
  db: DatabaseType,
  id: number,
  data: AdminProductUpdateRequest
): AdminProduct | null {
  const existing = getProduct(db, id);
  if (!existing) return null;

  for (const field of ["title", "asin", "imageUrl", "description", "category", "manufacturer"] as const) {
    if (data[field] !== undefined) validateFieldLength(field, data[field]);
  }
  if (data.imageUrl && !/^https?:\/\//i.test(data.imageUrl)) {
    throw new Error("imageUrl must be an HTTP or HTTPS URL");
  }

  // Column names in the fields array below are always string literals, never user input.
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.title !== undefined) {
    if (typeof data.title !== "string" || data.title.trim().length === 0) {
      throw new Error("Title cannot be empty");
    }
    fields.push("title = ?");
    values.push(data.title.trim());
  }
  if (data.priceCents !== undefined) {
    if (typeof data.priceCents !== "number" || data.priceCents < 0) {
      throw new Error("Price must be a non-negative number");
    }
    if (data.priceCents > 100_000_000 || !Number.isSafeInteger(data.priceCents)) {
      throw new Error("Price exceeds maximum allowed value");
    }
    fields.push("price_cents = ?");
    values.push(data.priceCents);
  }
  if (data.asin !== undefined) {
    fields.push("asin = ?");
    values.push(data.asin);
  }
  if (data.imageUrl !== undefined) {
    fields.push("image_url = ?");
    values.push(data.imageUrl);
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
  }
  if (data.category !== undefined) {
    fields.push("category = ?");
    values.push(data.category);
  }
  if (data.manufacturer !== undefined) {
    fields.push("manufacturer = ?");
    values.push(data.manufacturer);
  }
  if (data.isActive !== undefined) {
    fields.push("is_active = ?");
    values.push(data.isActive ? 1 : 0);
  }

  if (fields.length === 0) return existing;

  values.push(id);
  db.prepare(`UPDATE products SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  invalidateCategoriesCache();
  return getProduct(db, id);
}

/**
 * Set a product's active status.
 *
 * @param db - Database instance.
 * @param id - Product ID.
 * @param isActive - Whether the product should be active.
 * @returns The updated product, or null if not found.
 */
export function setProductActive(
  db: DatabaseType,
  id: number,
  isActive: boolean
): AdminProduct | null {
  const existing = getProduct(db, id);
  if (!existing) return null;

  if (isActive) {
    // Activating a product also clears its archived flag to prevent inconsistent state
    db.prepare("UPDATE products SET is_active = 1, is_archived = 0 WHERE id = ?").run(id);
  } else {
    db.prepare("UPDATE products SET is_active = 0 WHERE id = ?").run(id);
  }
  invalidateCategoriesCache();
  return getProduct(db, id);
}

/**
 * Bulk-update active status for multiple products.
 *
 * @param db - Database instance.
 * @param ids - Array of product IDs to update.
 * @param isActive - Whether the products should be active.
 * @returns The number of rows updated.
 */
export function bulkSetProductActive(
  db: DatabaseType,
  ids: number[],
  isActive: boolean
): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const result = db
    .prepare(`UPDATE products SET is_active = ? WHERE id IN (${placeholders})`)
    .run(isActive ? 1 : 0, ...ids);
  if (result.changes > 0) invalidateCategoriesCache();
  return result.changes;
}

/**
 * Set a product's archived status. Archiving also deactivates the product.
 *
 * @param db - Database instance.
 * @param id - Product ID.
 * @param isArchived - Whether the product should be archived.
 * @returns The updated product, or null if not found.
 */
export function setProductArchived(
  db: DatabaseType,
  id: number,
  isArchived: boolean
): AdminProduct | null {
  const existing = getProduct(db, id);
  if (!existing) return null;

  if (isArchived) {
    // Archiving also deactivates the product
    db.prepare("UPDATE products SET is_archived = 1, is_active = 0 WHERE id = ?").run(id);
  } else {
    // Unarchiving only clears the archived flag; product stays inactive until manually reactivated
    db.prepare("UPDATE products SET is_archived = 0 WHERE id = ?").run(id);
  }
  invalidateCategoriesCache();
  return getProduct(db, id);
}

/**
 * Bulk-update archived status for multiple products.
 *
 * @param db - Database instance.
 * @param ids - Array of product IDs to update.
 * @param isArchived - Whether the products should be archived.
 * @returns The number of rows updated.
 */
export function bulkSetProductArchived(
  db: DatabaseType,
  ids: number[],
  isArchived: boolean
): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  if (isArchived) {
    const result = db
      .prepare(`UPDATE products SET is_archived = 1, is_active = 0 WHERE id IN (${placeholders})`)
      .run(...ids);
    if (result.changes > 0) invalidateCategoriesCache();
    return result.changes;
  } else {
    const result = db
      .prepare(`UPDATE products SET is_archived = 0 WHERE id IN (${placeholders})`)
      .run(...ids);
    if (result.changes > 0) invalidateCategoriesCache();
    return result.changes;
  }
}

/**
 * Get all distinct product categories.
 *
 * @param db - Database instance.
 * @returns Array of category strings.
 */
export function getProductCategories(db: DatabaseType): string[] {
  const rows = db
    .prepare("SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category")
    .all() as { category: string }[];
  return rows.map((r) => r.category);
}

/** ASIN must be exactly 10 uppercase alphanumeric characters. */
const ASIN_REGEX = /^[A-Z0-9]{10}$/;

/** Maximum price in cents ($10,000). */
const MAX_PRICE_CENTS = 1000000;

/**
 * Insert or update a product by ASIN.
 *
 * If a product with the given ASIN already exists, its fields are updated.
 * Otherwise a new product is created. Always sets `scraped_at` to now and
 * `is_active` to true.
 *
 * @param db - Database instance.
 * @param data - Product data from the Chrome extension.
 * @returns The product and whether it was newly created.
 * @throws On missing/invalid ASIN, missing title, or invalid price.
 */
export function upsertProductByAsin(
  db: DatabaseType,
  data: ExtensionImportRequest
): { product: AdminProduct; created: boolean } {
  if (!data.asin || data.asin.trim().length === 0) {
    throw new Error("ASIN is required");
  }
  if (!ASIN_REGEX.test(data.asin)) {
    throw new Error("Invalid ASIN format");
  }
  if (!data.title || typeof data.title !== "string" || data.title.trim().length === 0) {
    throw new Error("Title is required");
  }
  if (data.priceCents === undefined || typeof data.priceCents !== "number" || data.priceCents < 0) {
    throw new Error("Price must be a non-negative number");
  }
  if (data.priceCents > MAX_PRICE_CENTS) {
    throw new Error("Price exceeds maximum");
  }

  for (const field of ["title", "imageUrl", "description", "category", "manufacturer"] as const) {
    if (data[field] !== undefined) validateFieldLength(field, data[field]);
  }

  if (data.imageUrl && !/^https?:\/\//i.test(data.imageUrl)) {
    throw new Error("imageUrl must be an HTTP or HTTPS URL");
  }

  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT * FROM products WHERE asin = ?")
    .get(data.asin) as Record<string, unknown> | undefined;

  if (existing) {
    db.prepare(
      `UPDATE products SET title = ?, price_cents = ?, image_url = ?, description = ?,
       category = ?, manufacturer = ?, scraped_at = ?, is_active = 1, is_archived = 0 WHERE asin = ?`
    ).run(
      data.title.trim(),
      data.priceCents,
      data.imageUrl ?? (existing.image_url as string | null),
      data.description ?? (existing.description as string | null),
      data.category ?? (existing.category as string | null),
      data.manufacturer ?? (existing.manufacturer as string | null),
      now,
      data.asin
    );
    invalidateCategoriesCache();
    return { product: getProduct(db, existing.id as number)!, created: false };
  }

  const result = db
    .prepare(
      `INSERT INTO products (asin, title, price_cents, image_url, description, category, manufacturer, is_active, added_at, scraped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      data.asin,
      data.title.trim(),
      data.priceCents,
      data.imageUrl ?? null,
      data.description ?? null,
      data.category ?? null,
      data.manufacturer ?? null,
      now,
      now
    );

  invalidateCategoriesCache();
  return { product: getProduct(db, result.lastInsertRowid as number)!, created: true };
}
