/**
 * Contacts database module for the manufacturer contacts pipeline.
 *
 * Creates and manages a separate SQLite database for storing manufacturer
 * contact information. This database is independent from the main game database.
 *
 * @module contacts-db
 */

import Database, { Database as DatabaseType } from "better-sqlite3";
import path from "path";
import fs from "fs";
import type {
  Manufacturer,
  Contact,
  SearchLogEntry,
  ContactInput,
  SearchStatus,
  ContactType,
  Confidence,
} from "./types";

const CONTACTS_DB_FILENAME = "manufacturer-contacts.db";

/** Valid values for ContactType enum. */
const VALID_CONTACT_TYPES: ReadonlySet<string> = new Set<string>([
  "media", "promotions", "pr", "partnerships", "general", "support",
]);

/** Valid values for Confidence enum. */
const VALID_CONFIDENCES: ReadonlySet<string> = new Set<string>(["high", "medium", "low"]);

/** Valid values for SearchStatus enum. */
const VALID_SEARCH_STATUSES: ReadonlySet<string> = new Set<string>(["pending", "searched", "verified"]);

/**
 * Validate that a contactType value is a valid ContactType enum member.
 *
 * @param value - Value to check.
 * @throws If the value is not a valid ContactType.
 */
function validateContactType(value: string): asserts value is ContactType {
  if (!VALID_CONTACT_TYPES.has(value)) {
    throw new Error(`Invalid contact_type: "${value}". Must be one of: ${[...VALID_CONTACT_TYPES].join(", ")}`);
  }
}

/**
 * Validate that a confidence value is a valid Confidence enum member.
 *
 * @param value - Value to check.
 * @throws If the value is not a valid Confidence.
 */
function validateConfidence(value: string): asserts value is Confidence {
  if (!VALID_CONFIDENCES.has(value)) {
    throw new Error(`Invalid confidence: "${value}". Must be one of: ${[...VALID_CONFIDENCES].join(", ")}`);
  }
}

/**
 * Validate that a status value is a valid SearchStatus enum member.
 *
 * @param value - Value to check.
 * @throws If the value is not a valid SearchStatus.
 */
function validateSearchStatus(value: string): asserts value is SearchStatus {
  if (!VALID_SEARCH_STATUSES.has(value)) {
    throw new Error(`Invalid search_status: "${value}". Must be one of: ${[...VALID_SEARCH_STATUSES].join(", ")}`);
  }
}

/**
 * Create the contacts database schema. Idempotent — safe to call multiple times.
 *
 * @param db - A better-sqlite3 database instance.
 */
export function createContactsDb(db: DatabaseType): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS manufacturers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      website TEXT,
      product_count INTEGER DEFAULT 0,
      search_status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manufacturer_id INTEGER NOT NULL,
      contact_type TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      contact_page_url TEXT,
      source_url TEXT,
      confidence TEXT DEFAULT 'medium',
      notes TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id)
    );

    CREATE TABLE IF NOT EXISTS search_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manufacturer_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      source TEXT NOT NULL,
      results_found INTEGER DEFAULT 0,
      searched_at TEXT NOT NULL,
      FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_manufacturers_normalized
      ON manufacturers(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_manufacturers_status
      ON manufacturers(search_status);
    CREATE INDEX IF NOT EXISTS idx_contacts_manufacturer
      ON contacts(manufacturer_id, contact_type);
    CREATE INDEX IF NOT EXISTS idx_search_log_manufacturer
      ON search_log(manufacturer_id);
  `);
}

/**
 * Open (or create) the contacts database at the standard data directory path.
 *
 * @param dataDir - Absolute path to the data directory (defaults to apps/server/data).
 * @returns A configured better-sqlite3 database instance.
 * @throws If the supplied dataDir is not an absolute path.
 */
export function openContactsDb(dataDir?: string): DatabaseType {
  const dir = dataDir ?? path.join(__dirname, "..", "..", "..", "data");
  if (!path.isAbsolute(dir)) {
    throw new Error(`dataDir must be an absolute path, got: "${dir}"`);
  }
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const dbPath = path.join(dir, CONTACTS_DB_FILENAME);
  const db = new Database(dbPath);
  createContactsDb(db);
  return db;
}

function now(): string {
  return new Date().toISOString();
}

function toManufacturer(row: Record<string, unknown>): Manufacturer {
  return {
    id: row.id as number,
    name: row.name as string,
    normalizedName: row.normalized_name as string,
    website: (row.website as string) ?? null,
    productCount: row.product_count as number,
    searchStatus: row.search_status as SearchStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toContact(row: Record<string, unknown>): Contact {
  return {
    id: row.id as number,
    manufacturerId: row.manufacturer_id as number,
    contactType: row.contact_type as Contact["contactType"],
    email: (row.email as string) ?? null,
    phone: (row.phone as string) ?? null,
    contactPageUrl: (row.contact_page_url as string) ?? null,
    sourceUrl: (row.source_url as string) ?? null,
    confidence: row.confidence as Contact["confidence"],
    notes: (row.notes as string) ?? null,
    verifiedAt: (row.verified_at as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toSearchLogEntry(row: Record<string, unknown>): SearchLogEntry {
  return {
    id: row.id as number,
    manufacturerId: row.manufacturer_id as number,
    query: row.query as string,
    source: row.source as string,
    resultsFound: row.results_found as number,
    searchedAt: row.searched_at as string,
  };
}

/**
 * Insert a new manufacturer into the contacts database.
 *
 * @param db - Database instance.
 * @param name - Canonical manufacturer/brand name.
 * @param productCount - Number of products from this manufacturer.
 * @returns The inserted Manufacturer record.
 * @throws If a manufacturer with the same normalized name already exists.
 */
export function insertManufacturer(
  db: DatabaseType,
  name: string,
  productCount: number
): Manufacturer {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO manufacturers (name, normalized_name, product_count, search_status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    )
    .run(trimmed, normalized, productCount, ts, ts);

  return {
    id: result.lastInsertRowid as number,
    name: trimmed,
    normalizedName: normalized,
    website: null,
    productCount,
    searchStatus: "pending",
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Find a manufacturer by name (case-insensitive).
 *
 * @param db - Database instance.
 * @param name - Manufacturer name to search for.
 * @returns The Manufacturer record or null if not found.
 */
export function getManufacturerByName(
  db: DatabaseType,
  name: string
): Manufacturer | null {
  const row = db
    .prepare("SELECT * FROM manufacturers WHERE normalized_name = ?")
    .get(name.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return row ? toManufacturer(row) : null;
}

/**
 * Find a manufacturer by ID.
 *
 * @param db - Database instance.
 * @param id - Manufacturer ID.
 * @returns The Manufacturer record or null if not found.
 */
export function getManufacturerById(
  db: DatabaseType,
  id: number
): Manufacturer | null {
  const row = db
    .prepare("SELECT * FROM manufacturers WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? toManufacturer(row) : null;
}

/**
 * Get all manufacturers, ordered by name.
 *
 * @param db - Database instance.
 * @returns Array of all Manufacturer records.
 */
export function getAllManufacturers(db: DatabaseType): Manufacturer[] {
  const rows = db
    .prepare("SELECT * FROM manufacturers ORDER BY name")
    .all() as Record<string, unknown>[];
  return rows.map(toManufacturer);
}

/**
 * Get all manufacturers that have not yet been searched.
 *
 * @param db - Database instance.
 * @returns Array of pending Manufacturer records.
 */
export function getPendingManufacturers(db: DatabaseType): Manufacturer[] {
  const rows = db
    .prepare(
      "SELECT * FROM manufacturers WHERE search_status = 'pending' ORDER BY name"
    )
    .all() as Record<string, unknown>[];
  return rows.map(toManufacturer);
}

/**
 * Update a manufacturer's search status.
 *
 * @param db - Database instance.
 * @param id - Manufacturer ID.
 * @param status - New search status.
 * @throws If the status is not a valid SearchStatus value.
 */
export function updateManufacturerSearchStatus(
  db: DatabaseType,
  id: number,
  status: SearchStatus
): void {
  validateSearchStatus(status);
  db.prepare(
    "UPDATE manufacturers SET search_status = ?, updated_at = ? WHERE id = ?"
  ).run(status, now(), id);
}

/**
 * Update a manufacturer's website URL.
 *
 * @param db - Database instance.
 * @param id - Manufacturer ID.
 * @param website - Website URL.
 */
export function updateManufacturerWebsite(
  db: DatabaseType,
  id: number,
  website: string
): void {
  db.prepare(
    "UPDATE manufacturers SET website = ?, updated_at = ? WHERE id = ?"
  ).run(website, now(), id);
}

/**
 * Update a manufacturer's product count.
 *
 * @param db - Database instance.
 * @param id - Manufacturer ID.
 * @param count - New product count.
 */
export function updateManufacturerProductCount(
  db: DatabaseType,
  id: number,
  count: number
): void {
  db.prepare(
    "UPDATE manufacturers SET product_count = ?, updated_at = ? WHERE id = ?"
  ).run(count, now(), id);
}

/**
 * Insert a contact record for a manufacturer.
 *
 * @param db - Database instance.
 * @param manufacturerId - ID of the manufacturer.
 * @param input - Contact data to insert.
 * @returns The inserted Contact record.
 * @throws If contactType or confidence values are invalid.
 */
export function insertContact(
  db: DatabaseType,
  manufacturerId: number,
  input: ContactInput
): Contact {
  validateContactType(input.contactType);
  validateConfidence(input.confidence);

  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO contacts
       (manufacturer_id, contact_type, email, phone, contact_page_url, source_url, confidence, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      manufacturerId,
      input.contactType,
      input.email ?? null,
      input.phone ?? null,
      input.contactPageUrl ?? null,
      input.sourceUrl ?? null,
      input.confidence,
      input.notes ?? null,
      ts,
      ts
    );

  return {
    id: result.lastInsertRowid as number,
    manufacturerId,
    contactType: input.contactType,
    email: input.email ?? null,
    phone: input.phone ?? null,
    contactPageUrl: input.contactPageUrl ?? null,
    sourceUrl: input.sourceUrl ?? null,
    confidence: input.confidence,
    notes: input.notes ?? null,
    verifiedAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Get all contacts for a manufacturer, ordered by confidence (high first).
 *
 * @param db - Database instance.
 * @param manufacturerId - Manufacturer ID.
 * @returns Array of Contact records.
 */
export function getContactsForManufacturer(
  db: DatabaseType,
  manufacturerId: number
): Contact[] {
  const rows = db
    .prepare(
      `SELECT * FROM contacts WHERE manufacturer_id = ?
       ORDER BY CASE confidence
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 3
         ELSE 4
       END, created_at`
    )
    .all(manufacturerId) as Record<string, unknown>[];
  return rows.map(toContact);
}

/**
 * Log a web search attempt for a manufacturer.
 *
 * @param db - Database instance.
 * @param manufacturerId - Manufacturer ID.
 * @param query - Search query used.
 * @param source - Search engine or source (e.g. "google", "website").
 * @param resultsFound - Number of results found.
 * @returns The inserted SearchLogEntry.
 */
export function insertSearchLog(
  db: DatabaseType,
  manufacturerId: number,
  query: string,
  source: string,
  resultsFound: number
): SearchLogEntry {
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO search_log (manufacturer_id, query, source, results_found, searched_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(manufacturerId, query, source, resultsFound, ts);

  return {
    id: result.lastInsertRowid as number,
    manufacturerId,
    query,
    source,
    resultsFound,
    searchedAt: ts,
  };
}

/**
 * Get all search logs for a manufacturer.
 *
 * @param db - Database instance.
 * @param manufacturerId - Manufacturer ID.
 * @returns Array of SearchLogEntry records.
 */
export function getSearchLogsForManufacturer(
  db: DatabaseType,
  manufacturerId: number
): SearchLogEntry[] {
  const rows = db
    .prepare(
      "SELECT * FROM search_log WHERE manufacturer_id = ? ORDER BY searched_at"
    )
    .all(manufacturerId) as Record<string, unknown>[];
  return rows.map(toSearchLogEntry);
}

/**
 * Get a manufacturer with all associated contacts.
 *
 * @param db - Database instance.
 * @param id - Manufacturer ID.
 * @returns Object with manufacturer and contacts, or null if not found.
 */
export function getManufacturerWithContacts(
  db: DatabaseType,
  id: number
): { manufacturer: Manufacturer; contacts: Contact[] } | null {
  const manufacturer = getManufacturerById(db, id);
  if (!manufacturer) return null;
  const contacts = getContactsForManufacturer(db, id);
  return { manufacturer, contacts };
}
