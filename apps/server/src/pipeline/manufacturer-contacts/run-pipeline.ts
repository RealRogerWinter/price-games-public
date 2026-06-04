#!/usr/bin/env tsx
/**
 * Manufacturer contacts pipeline runner.
 *
 * CLI entry point for the manufacturer contacts pipeline. Designed to be
 * invoked by Claude Code (or manually) to orchestrate the extraction,
 * search, and loading steps.
 *
 * Usage:
 *   npx tsx run-pipeline.ts extract        — Extract manufacturers from product DB
 *   npx tsx run-pipeline.ts status         — Show pipeline status
 *   npx tsx run-pipeline.ts pending        — List manufacturers needing contact search
 *   npx tsx run-pipeline.ts load <json>    — Load search results (JSON string or file path)
 *   npx tsx run-pipeline.ts backup         — Back up the contacts database
 *   npx tsx run-pipeline.ts restore <file> — Restore contacts database from backup
 *   npx tsx run-pipeline.ts queries <name> — Generate search queries for a manufacturer
 *   npx tsx run-pipeline.ts dump           — Dump all manufacturers and contacts as JSON
 *
 * @module run-pipeline
 */

import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import {
  createContactsDb,
  openContactsDb,
  insertManufacturer,
  getManufacturerByName,
  getAllManufacturers,
  getPendingManufacturers,
  updateManufacturerSearchStatus,
  updateManufacturerWebsite,
  insertContact,
  insertSearchLog,
  getManufacturerWithContacts,
} from "./contacts-db";
import {
  extractManufacturersFromProducts,
  aggregateManufacturers,
} from "./extract-manufacturers";
import {
  generateSearchQueries,
  parseContactSearchResult,
  formatSearchAgentPrompt,
} from "./search-contacts";
import { backupContactsDb, restoreContactsDb, getBackupStatus } from "./backup";
import type { ProductRow, ContactSearchResult, ContactType, Confidence } from "./types";

const DATA_DIR = path.join(__dirname, "..", "..", "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "backup", "manufacturer-contacts");
const GAME_DB_PATH = path.join(DATA_DIR, "price-game.db");

/** Maximum file size for JSON input reads (50 MB). */
const MAX_INPUT_FILE_SIZE = 50 * 1024 * 1024;

/** Valid values for ContactType enum. */
const VALID_CONTACT_TYPES: ReadonlySet<string> = new Set<string>([
  "media", "promotions", "pr", "partnerships", "general", "support",
]);

/** Valid values for Confidence enum. */
const VALID_CONFIDENCES: ReadonlySet<string> = new Set<string>(["high", "medium", "low"]);

/**
 * Verify that a file path, once canonicalized, falls within an allowed directory.
 *
 * @param filePath - The path to verify.
 * @param allowedDirs - Array of allowed parent directories.
 * @returns The canonicalized absolute path.
 * @throws If the path resolves outside the allowed directories.
 */
function verifyPathWithin(filePath: string, allowedDirs: string[]): string {
  const resolved = path.resolve(filePath);
  const withinAllowed = allowedDirs.some(
    (dir) => resolved.startsWith(dir + path.sep) || resolved === dir
  );
  if (!withinAllowed) {
    throw new Error(
      `Path "${resolved}" is outside allowed directories: ${allowedDirs.join(", ")}`
    );
  }
  return resolved;
}

/**
 * Validate that parsed JSON conforms to the ContactSearchResult structure.
 *
 * @param data - The parsed JSON value to validate.
 * @throws If the structure is invalid or enum values are out of range.
 */
function validateContactSearchResult(data: unknown): asserts data is ContactSearchResult {
  if (data === null || typeof data !== "object") {
    throw new Error("Input must be a non-null object");
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.manufacturer !== "string" || obj.manufacturer.length === 0) {
    throw new Error("Input must have a non-empty 'manufacturer' string");
  }

  if (!Array.isArray(obj.contacts)) {
    throw new Error("Input must have a 'contacts' array");
  }

  for (const c of obj.contacts) {
    if (typeof c !== "object" || c === null) {
      throw new Error("Each contact must be a non-null object");
    }
    const contact = c as Record<string, unknown>;
    if (typeof contact.contactType === "string" && !VALID_CONTACT_TYPES.has(contact.contactType)) {
      throw new Error(`Invalid contactType: "${contact.contactType}"`);
    }
    if (typeof contact.confidence === "string" && !VALID_CONFIDENCES.has(contact.confidence)) {
      throw new Error(`Invalid confidence: "${contact.confidence}"`);
    }
  }
}

/**
 * Open the main game database (read-only for product queries).
 */
function openGameDb(): InstanceType<typeof Database> {
  if (!fs.existsSync(GAME_DB_PATH)) {
    console.error(`Game database not found at ${GAME_DB_PATH}`);
    console.error("Run 'npm run seed' first to create the product database.");
    process.exit(1);
  }
  return new Database(GAME_DB_PATH, { readonly: true });
}

/**
 * Extract manufacturers from the product database and load them into the contacts DB.
 */
function cmdExtract(): void {
  console.log("=== Manufacturer Extraction ===\n");

  const gameDb = openGameDb();
  const contactsDb = openContactsDb(DATA_DIR);

  try {
    // Query all active products
    const products = gameDb
      .prepare(
        "SELECT id, asin, title, category, manufacturer FROM products WHERE is_active = 1"
      )
      .all() as ProductRow[];

    console.log(`Found ${products.length} active products in game database.\n`);

    // Extract manufacturers from product titles
    const extractions = extractManufacturersFromProducts(products);
    const counts = aggregateManufacturers(extractions);

    console.log(`Identified ${counts.size} unique manufacturers:\n`);

    let inserted = 0;
    let skipped = 0;

    for (const [name, count] of counts.entries()) {
      const existing = getManufacturerByName(contactsDb, name);
      if (existing) {
        console.log(`  [skip] ${name} (${count} products) — already in contacts DB`);
        skipped++;
      } else {
        insertManufacturer(contactsDb, name, count);
        console.log(`  [new]  ${name} (${count} products)`);
        inserted++;
      }
    }

    // Show low-confidence extractions as warnings
    const lowConf = extractions.filter((e) => e.confidence === "low");
    if (lowConf.length > 0) {
      console.log(`\nWarning: ${lowConf.length} products had low-confidence manufacturer extraction:`);
      for (const e of lowConf) {
        console.log(`  - "${e.productTitle}" → ${e.manufacturer} (low confidence)`);
      }
      console.log(
        "\nConsider searching Amazon/Google for these products to confirm the manufacturer."
      );
    }

    console.log(`\nDone. Inserted: ${inserted}, Skipped: ${skipped}`);
  } finally {
    gameDb.close();
    contactsDb.close();
  }
}

/**
 * Show pipeline status: how many manufacturers, contacts, searches, etc.
 */
function cmdStatus(): void {
  console.log("=== Manufacturer Contacts Pipeline Status ===\n");

  const contactsDb = openContactsDb(DATA_DIR);
  try {
    const all = getAllManufacturers(contactsDb);
    const pending = getPendingManufacturers(contactsDb);
    const backup = getBackupStatus(contactsDb, BACKUP_DIR);

    console.log(`Manufacturers: ${all.length} total, ${pending.length} pending search`);
    console.log(`Contacts:      ${backup.dbContacts}`);
    console.log(`Search logs:   ${backup.dbSearchLogs}`);
    console.log(`Backup files:  ${backup.backupFiles.length}`);

    if (all.length > 0) {
      const searched = all.filter((m) => m.searchStatus === "searched").length;
      const verified = all.filter((m) => m.searchStatus === "verified").length;
      console.log(`\nSearch progress:`);
      console.log(`  Pending:  ${pending.length}`);
      console.log(`  Searched: ${searched}`);
      console.log(`  Verified: ${verified}`);
    }
  } finally {
    contactsDb.close();
  }
}

/**
 * List manufacturers that still need contact searches.
 */
function cmdPending(): void {
  const contactsDb = openContactsDb(DATA_DIR);
  try {
    const pending = getPendingManufacturers(contactsDb);

    if (pending.length === 0) {
      console.log("All manufacturers have been searched.");
      return;
    }

    console.log(`${pending.length} manufacturers pending contact search:\n`);
    for (const m of pending) {
      console.log(`  - ${m.name} (${m.productCount} products)`);
    }

    // Also output as JSON for programmatic consumption
    console.log("\n--- JSON ---");
    console.log(JSON.stringify(pending.map((m) => m.name)));
  } finally {
    contactsDb.close();
  }
}

/**
 * Load contact search results into the database.
 * Accepts a JSON string or a file path to a JSON file.
 */
function cmdLoad(input: string): void {
  let raw: string;

  // Determine if input is a file path or an inline JSON string
  if (fs.existsSync(input)) {
    // Validate path is within allowed directories
    const resolved = verifyPathWithin(input, [DATA_DIR, BACKUP_DIR]);

    // Enforce file size limit before reading
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_INPUT_FILE_SIZE) {
      console.error(`File exceeds maximum size of ${MAX_INPUT_FILE_SIZE} bytes`);
      process.exit(1);
    }
    raw = fs.readFileSync(resolved, "utf-8");
  } else {
    raw = input;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Failed to parse JSON input. Expected a ContactSearchResult object.");
    process.exit(1);
  }

  // Runtime schema validation
  validateContactSearchResult(parsed);
  const data: ContactSearchResult = parsed;

  const validated = parseContactSearchResult(data);
  const contactsDb = openContactsDb(DATA_DIR);

  try {
    const manufacturer = getManufacturerByName(contactsDb, validated.manufacturer);
    if (!manufacturer) {
      console.error(
        `Manufacturer "${validated.manufacturer}" not found in contacts DB. Run 'extract' first.`
      );
      process.exit(1);
    }

    // Update website if provided
    if (validated.website) {
      updateManufacturerWebsite(contactsDb, manufacturer.id, validated.website);
      console.log(`Updated website: ${validated.website}`);
    }

    // Insert contacts
    let contactCount = 0;
    for (const contact of validated.contacts) {
      insertContact(contactsDb, manufacturer.id, contact);
      contactCount++;
      console.log(
        `Added ${contact.contactType} contact: ${contact.email || contact.phone || contact.contactPageUrl}`
      );
    }

    // Log the search
    insertSearchLog(
      contactsDb,
      manufacturer.id,
      `Contact search for ${validated.manufacturer}`,
      "claude-code",
      contactCount
    );

    // Mark as searched
    updateManufacturerSearchStatus(contactsDb, manufacturer.id, "searched");

    console.log(
      `\nLoaded ${contactCount} contacts for ${validated.manufacturer}. Status: searched.`
    );
  } finally {
    contactsDb.close();
  }
}

/**
 * Generate search queries for a specific manufacturer.
 */
function cmdQueries(manufacturer: string): void {
  const contactsDb = openContactsDb(DATA_DIR);
  try {
    const mfg = getManufacturerByName(contactsDb, manufacturer);

    const queries = generateSearchQueries(manufacturer);
    console.log(`Search queries for "${manufacturer}":\n`);
    for (const q of queries) {
      console.log(`  ${q}`);
    }

    console.log("\n--- Agent Prompt ---");
    console.log(formatSearchAgentPrompt(manufacturer, mfg?.website ?? undefined));
  } finally {
    contactsDb.close();
  }
}

/**
 * Back up the contacts database.
 */
function cmdBackup(): void {
  const contactsDb = openContactsDb(DATA_DIR);
  try {
    const backupPath = backupContactsDb(contactsDb, BACKUP_DIR);
    console.log(`Backup created: ${backupPath}`);
  } finally {
    contactsDb.close();
  }
}

/**
 * Restore the contacts database from a backup file.
 */
function cmdRestore(filePath: string): void {
  // Canonicalize and verify path is within BACKUP_DIR
  const resolved = verifyPathWithin(filePath, [BACKUP_DIR]);

  if (!fs.existsSync(resolved)) {
    console.error(`Backup file not found: ${resolved}`);
    process.exit(1);
  }

  const contactsDb = openContactsDb(DATA_DIR);
  try {
    const stats = restoreContactsDb(contactsDb, resolved);

    console.log("Restore complete:");
    console.log(`  Manufacturers: ${stats.manufacturersRestored} restored, ${stats.manufacturersSkipped} skipped`);
    console.log(`  Contacts: ${stats.contactsRestored} restored`);
    console.log(`  Search logs: ${stats.searchLogsRestored} restored`);
  } finally {
    contactsDb.close();
  }
}

/**
 * Dump all manufacturers and their contacts as JSON.
 */
function cmdDump(): void {
  const contactsDb = openContactsDb(DATA_DIR);
  try {
    const all = getAllManufacturers(contactsDb);

    const result = all.map((m) => {
      const data = getManufacturerWithContacts(contactsDb, m.id);
      return data;
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    contactsDb.close();
  }
}

// --- CLI ---
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case "extract":
    cmdExtract();
    break;
  case "status":
    cmdStatus();
    break;
  case "pending":
    cmdPending();
    break;
  case "load":
    if (!arg) {
      console.error("Usage: run-pipeline.ts load <json-string-or-file>");
      process.exit(1);
    }
    cmdLoad(arg);
    break;
  case "queries":
    if (!arg) {
      console.error("Usage: run-pipeline.ts queries <manufacturer-name>");
      process.exit(1);
    }
    cmdQueries(arg);
    break;
  case "backup":
    cmdBackup();
    break;
  case "restore":
    if (!arg) {
      console.error("Usage: run-pipeline.ts restore <backup-file>");
      process.exit(1);
    }
    cmdRestore(arg);
    break;
  case "dump":
    cmdDump();
    break;
  default:
    console.log(`Manufacturer Contacts Pipeline

Usage: npx tsx run-pipeline.ts <command> [args]

Commands:
  extract        Extract manufacturers from product DB into contacts DB
  status         Show pipeline status (counts, search progress)
  pending        List manufacturers needing contact search
  load <json>    Load contact search results (JSON string or file path)
  queries <name> Generate web search queries for a manufacturer
  backup         Back up the contacts database
  restore <file> Restore contacts database from a backup file
  dump           Dump all data as JSON

Typical workflow (orchestrated by Claude Code):
  1. extract     — populate manufacturer list
  2. pending     — get list of manufacturers to search
  3. queries X   — get search queries + agent prompt for manufacturer X
  4. [web search via Claude Code sub-agents]
  5. load {...}  — load search results
  6. repeat 2-5 for each manufacturer
  7. backup      — save a backup`);
    break;
}
