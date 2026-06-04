/**
 * Backup and restore module for the manufacturer contacts database.
 *
 * Exports the contacts database to timestamped JSON files and restores from
 * those backups. Follows the same pattern as the main game's backup-restore.ts
 * but operates on the separate contacts database.
 *
 * @module backup
 */

import { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { BackupManifest, ContactInput, ContactType, Confidence, SearchStatus } from "./types";
import {
  getManufacturerByName,
  insertManufacturer,
  insertContact,
  insertSearchLog,
} from "./contacts-db";

/** Maximum backup file size in bytes (50 MB). */
const MAX_BACKUP_FILE_SIZE = 50 * 1024 * 1024;

/** Valid values for SearchStatus enum. */
const VALID_SEARCH_STATUSES: ReadonlySet<string> = new Set<string>(["pending", "searched", "verified"]);

/** Valid values for ContactType enum. */
const VALID_CONTACT_TYPES: ReadonlySet<string> = new Set<string>([
  "media", "promotions", "pr", "partnerships", "general", "support",
]);

/** Valid values for Confidence enum. */
const VALID_CONFIDENCES: ReadonlySet<string> = new Set<string>(["high", "medium", "low"]);

interface BackupData {
  manifest: BackupManifest;
  manufacturers: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
  searchLogs: Record<string, unknown>[];
}

interface RestoreStats {
  manufacturersRestored: number;
  manufacturersSkipped: number;
  contactsRestored: number;
  searchLogsRestored: number;
}

interface BackupStatus {
  dbManufacturers: number;
  dbContacts: number;
  dbSearchLogs: number;
  backupFiles: string[];
}

/**
 * Validate that parsed JSON conforms to the expected BackupData structure.
 *
 * @param data - The parsed JSON value to validate.
 * @throws If the structure is invalid or enum values are out of range.
 */
function validateBackupData(data: unknown): asserts data is BackupData {
  if (data === null || typeof data !== "object") {
    throw new Error("Backup data must be a non-null object");
  }

  const obj = data as Record<string, unknown>;

  if (!obj.manifest || typeof obj.manifest !== "object") {
    throw new Error("Backup data must contain a manifest object");
  }

  if (!Array.isArray(obj.manufacturers)) {
    throw new Error("Backup data must contain a manufacturers array");
  }

  if (!Array.isArray(obj.contacts)) {
    throw new Error("Backup data must contain a contacts array");
  }

  if (!Array.isArray(obj.searchLogs)) {
    throw new Error("Backup data must contain a searchLogs array");
  }

  // Validate enum values in manufacturers
  for (const m of obj.manufacturers) {
    if (typeof m !== "object" || m === null) {
      throw new Error("Each manufacturer must be a non-null object");
    }
    const mfg = m as Record<string, unknown>;
    if (typeof mfg.name !== "string") {
      throw new Error("Manufacturer name must be a string");
    }
    if (mfg.search_status !== undefined && mfg.search_status !== null) {
      if (!VALID_SEARCH_STATUSES.has(mfg.search_status as string)) {
        throw new Error(`Invalid search_status: ${mfg.search_status}`);
      }
    }
  }

  // Validate enum values in contacts
  for (const c of obj.contacts) {
    if (typeof c !== "object" || c === null) {
      throw new Error("Each contact must be a non-null object");
    }
    const contact = c as Record<string, unknown>;
    if (contact.contact_type !== undefined && contact.contact_type !== null) {
      if (!VALID_CONTACT_TYPES.has(contact.contact_type as string)) {
        throw new Error(`Invalid contact_type: ${contact.contact_type}`);
      }
    }
    if (contact.confidence !== undefined && contact.confidence !== null) {
      if (!VALID_CONFIDENCES.has(contact.confidence as string)) {
        throw new Error(`Invalid confidence: ${contact.confidence}`);
      }
    }
  }
}

/**
 * Create a full JSON backup of the contacts database.
 *
 * @param db - Contacts database instance.
 * @param backupDir - Directory to write the backup file into.
 * @returns Absolute path to the created backup file.
 */
export function backupContactsDb(db: DatabaseType, backupDir: string): string {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  }

  const manufacturers = db
    .prepare("SELECT * FROM manufacturers ORDER BY id")
    .all() as Record<string, unknown>[];

  const contacts = db
    .prepare("SELECT * FROM contacts ORDER BY id")
    .all() as Record<string, unknown>[];

  const searchLogs = db
    .prepare("SELECT * FROM search_log ORDER BY id")
    .all() as Record<string, unknown>[];

  const timestamp = new Date();
  const manifest: BackupManifest = {
    backedUpAt: timestamp.toISOString(),
    totalManufacturers: manufacturers.length,
    totalContacts: contacts.length,
    totalSearchLogs: searchLogs.length,
    version: 1,
  };

  const data: BackupData = {
    manifest,
    manufacturers,
    contacts,
    searchLogs,
  };

  const fileTimestamp = timestamp.toISOString().replace(/:/g, "-");
  const filename = `manufacturer-contacts-${fileTimestamp}.json`;
  const filePath = path.join(backupDir, filename);

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return filePath;
}

/**
 * Restore a contacts database from a JSON backup file.
 *
 * Skips manufacturers that already exist (by normalized name) to support
 * idempotent restores. Contacts and search logs for skipped manufacturers
 * are also skipped.
 *
 * @param db - Target contacts database instance.
 * @param backupPath - Path to the backup JSON file.
 * @returns Statistics about the restore operation.
 * @throws If the file exceeds the 50 MB size limit or contains invalid data.
 */
export function restoreContactsDb(
  db: DatabaseType,
  backupPath: string
): RestoreStats {
  // Enforce file size limit before reading
  const fileStat = fs.statSync(backupPath);
  if (fileStat.size > MAX_BACKUP_FILE_SIZE) {
    throw new Error(
      `Backup file exceeds maximum size of ${MAX_BACKUP_FILE_SIZE} bytes (actual: ${fileStat.size})`
    );
  }

  const raw = fs.readFileSync(backupPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  validateBackupData(parsed);
  const data: BackupData = parsed;

  const stats: RestoreStats = {
    manufacturersRestored: 0,
    manufacturersSkipped: 0,
    contactsRestored: 0,
    searchLogsRestored: 0,
  };

  // Build a map of old manufacturer ID -> new manufacturer ID
  const idMap = new Map<number, number>();
  // Track which old manufacturer IDs were newly inserted (not skipped)
  const newlyInsertedOldIds = new Set<number>();

  const restoreTx = db.transaction(() => {
    // Restore manufacturers
    for (const m of data.manufacturers) {
      const name = m.name as string;
      const oldId = m.id as number;
      const existing = getManufacturerByName(db, name);
      if (existing) {
        stats.manufacturersSkipped++;
        idMap.set(oldId, existing.id);
        continue;
      }
      const inserted = insertManufacturer(db, name, m.product_count as number);

      // Restore additional fields that insertManufacturer doesn't set
      if (m.website) {
        db.prepare("UPDATE manufacturers SET website = ? WHERE id = ?").run(
          m.website,
          inserted.id
        );
      }
      if (m.search_status && m.search_status !== "pending") {
        db.prepare(
          "UPDATE manufacturers SET search_status = ? WHERE id = ?"
        ).run(m.search_status, inserted.id);
      }

      idMap.set(oldId, inserted.id);
      newlyInsertedOldIds.add(oldId);
      stats.manufacturersRestored++;
    }

    // Restore contacts only for newly inserted manufacturers
    for (const c of data.contacts) {
      const oldMfgId = c.manufacturer_id as number;
      if (!newlyInsertedOldIds.has(oldMfgId)) continue;

      const newMfgId = idMap.get(oldMfgId)!;
      insertContact(db, newMfgId, {
        contactType: c.contact_type as ContactType,
        email: (c.email as string) || undefined,
        phone: (c.phone as string) || undefined,
        contactPageUrl: (c.contact_page_url as string) || undefined,
        sourceUrl: (c.source_url as string) || undefined,
        confidence: (c.confidence as Confidence) || "medium",
        notes: (c.notes as string) || undefined,
      });
      stats.contactsRestored++;
    }

    // Restore search logs only for newly inserted manufacturers
    for (const log of data.searchLogs) {
      const oldMfgId = log.manufacturer_id as number;
      if (!newlyInsertedOldIds.has(oldMfgId)) continue;

      const newMfgId = idMap.get(oldMfgId)!;
      insertSearchLog(
        db,
        newMfgId,
        log.query as string,
        log.source as string,
        log.results_found as number
      );
      stats.searchLogsRestored++;
    }
  });

  restoreTx();
  return stats;
}

/**
 * Get a summary of the current database state and available backups.
 *
 * @param db - Contacts database instance.
 * @param backupDir - Backup directory path.
 * @returns Status object with counts and file list.
 */
export function getBackupStatus(
  db: DatabaseType,
  backupDir: string
): BackupStatus {
  const mfgCount = (
    db.prepare("SELECT COUNT(*) as c FROM manufacturers").get() as {
      c: number;
    }
  ).c;
  const contactCount = (
    db.prepare("SELECT COUNT(*) as c FROM contacts").get() as { c: number }
  ).c;
  const logCount = (
    db.prepare("SELECT COUNT(*) as c FROM search_log").get() as { c: number }
  ).c;

  let backupFiles: string[] = [];
  try {
    if (fs.existsSync(backupDir)) {
      backupFiles = fs
        .readdirSync(backupDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return {
    dbManufacturers: mfgCount,
    dbContacts: contactCount,
    dbSearchLogs: logCount,
    backupFiles,
  };
}
