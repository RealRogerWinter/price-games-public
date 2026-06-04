/**
 * Admin manufacturer contacts service.
 *
 * Thin service layer that wraps the pipeline contacts-db functions for use
 * by the admin API. Accepts an injected database instance so tests can use
 * in-memory databases.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type {
  AdminManufacturerWithContacts,
  AdminContact,
  AdminContactCreateRequest,
  AdminContactUpdateRequest,
} from "@price-game/shared";
import {
  getManufacturerByName,
  getManufacturerById,
  getContactsForManufacturer,
  insertContact,
} from "../pipeline/manufacturer-contacts/contacts-db";
import type { Manufacturer, Contact } from "../pipeline/manufacturer-contacts/types";

/** Valid values for ContactType. */
const VALID_CONTACT_TYPES = new Set([
  "media", "promotions", "pr", "partnerships", "general", "support",
]);

/** Valid values for Confidence. */
const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);

/** Maximum field lengths for contact input validation. */
const CONTACT_MAX_LENGTHS: Record<string, number> = {
  email: 320,
  phone: 50,
  contactPageUrl: 2048,
  sourceUrl: 2048,
  notes: 2000,
};

/**
 * Validate contact field lengths.
 *
 * @param data - Object with potential string fields to validate.
 * @throws If any field exceeds its maximum length.
 */
function validateContactFields(data: Record<string, unknown>): void {
  for (const [field, maxLen] of Object.entries(CONTACT_MAX_LENGTHS)) {
    const value = data[field];
    if (typeof value === "string" && value.length > maxLen) {
      throw new Error(`${field} exceeds maximum length of ${maxLen} characters`);
    }
  }
}

/**
 * Map a pipeline Manufacturer to an AdminManufacturer.
 *
 * @param m - Pipeline manufacturer record.
 * @returns Mapped admin manufacturer.
 */
function toAdminManufacturer(m: Manufacturer) {
  return {
    id: m.id,
    name: m.name,
    website: m.website,
    productCount: m.productCount,
    searchStatus: m.searchStatus,
  };
}

/**
 * Map a pipeline Contact to an AdminContact.
 *
 * @param c - Pipeline contact record.
 * @returns Mapped admin contact.
 */
function toAdminContact(c: Contact): AdminContact {
  return {
    id: c.id,
    manufacturerId: c.manufacturerId,
    contactType: c.contactType as AdminContact["contactType"],
    email: c.email,
    phone: c.phone,
    contactPageUrl: c.contactPageUrl,
    sourceUrl: c.sourceUrl,
    confidence: c.confidence as AdminContact["confidence"],
    notes: c.notes,
    verifiedAt: c.verifiedAt,
  };
}

/**
 * Map a raw database row to an AdminContact.
 *
 * @param row - Raw database row from the contacts table.
 * @returns Mapped admin contact.
 */
function rowToAdminContact(row: Record<string, unknown>): AdminContact {
  return {
    id: row.id as number,
    manufacturerId: row.manufacturer_id as number,
    contactType: row.contact_type as AdminContact["contactType"],
    email: (row.email as string) ?? null,
    phone: (row.phone as string) ?? null,
    contactPageUrl: (row.contact_page_url as string) ?? null,
    sourceUrl: (row.source_url as string) ?? null,
    confidence: row.confidence as AdminContact["confidence"],
    notes: (row.notes as string) ?? null,
    verifiedAt: (row.verified_at as string) ?? null,
  };
}

/**
 * Look up a manufacturer by name and return with contacts.
 *
 * @param db - Contacts database instance.
 * @param name - Manufacturer name to search for (case-insensitive).
 * @returns Manufacturer with contacts, or null if not found.
 */
export function getManufacturerContactsByName(
  db: DatabaseType,
  name: string
): AdminManufacturerWithContacts | null {
  const manufacturer = getManufacturerByName(db, name);
  if (!manufacturer) return null;

  const contacts = getContactsForManufacturer(db, manufacturer.id);
  return {
    manufacturer: toAdminManufacturer(manufacturer),
    contacts: contacts.map(toAdminContact),
  };
}

/**
 * Add a new contact record for a manufacturer.
 *
 * @param db - Contacts database instance.
 * @param manufacturerId - Manufacturer ID.
 * @param input - Contact creation data.
 * @returns The created contact.
 * @throws If the manufacturer doesn't exist, or input is invalid.
 */
export function addManufacturerContact(
  db: DatabaseType,
  manufacturerId: number,
  input: AdminContactCreateRequest
): AdminContact {
  const manufacturer = getManufacturerById(db, manufacturerId);
  if (!manufacturer) {
    throw new Error("Manufacturer not found");
  }

  if (!input.contactType || !VALID_CONTACT_TYPES.has(input.contactType)) {
    throw new Error(
      `Invalid contactType: "${input.contactType}". Must be one of: ${[...VALID_CONTACT_TYPES].join(", ")}`
    );
  }
  if (!input.confidence || !VALID_CONFIDENCES.has(input.confidence)) {
    throw new Error(
      `Invalid confidence: "${input.confidence}". Must be one of: ${[...VALID_CONFIDENCES].join(", ")}`
    );
  }
  validateContactFields(input as unknown as Record<string, unknown>);

  const contact = insertContact(db, manufacturerId, {
    contactType: input.contactType as Contact["contactType"],
    email: input.email,
    phone: input.phone,
    contactPageUrl: input.contactPageUrl,
    sourceUrl: input.sourceUrl,
    confidence: input.confidence as Contact["confidence"],
    notes: input.notes,
  });

  return toAdminContact(contact);
}

/**
 * Update fields on an existing contact.
 *
 * @param db - Contacts database instance.
 * @param contactId - Contact ID.
 * @param data - Partial update data.
 * @returns The updated contact, or null if not found.
 */
export function updateManufacturerContact(
  db: DatabaseType,
  contactId: number,
  data: AdminContactUpdateRequest,
  manufacturerId?: number
): AdminContact | null {
  const existing = db
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(contactId) as Record<string, unknown> | undefined;
  if (!existing) return null;
  if (manufacturerId !== undefined && existing.manufacturer_id !== manufacturerId) return null;
  validateContactFields(data as unknown as Record<string, unknown>);

  // Column names in the fields array below are always string literals, never user input.
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.contactType !== undefined) {
    if (!VALID_CONTACT_TYPES.has(data.contactType)) {
      throw new Error(`Invalid contactType: "${data.contactType}"`);
    }
    fields.push("contact_type = ?");
    values.push(data.contactType);
  }
  if (data.email !== undefined) {
    fields.push("email = ?");
    values.push(data.email || null);
  }
  if (data.phone !== undefined) {
    fields.push("phone = ?");
    values.push(data.phone || null);
  }
  if (data.contactPageUrl !== undefined) {
    fields.push("contact_page_url = ?");
    values.push(data.contactPageUrl || null);
  }
  if (data.sourceUrl !== undefined) {
    fields.push("source_url = ?");
    values.push(data.sourceUrl || null);
  }
  if (data.confidence !== undefined) {
    if (!VALID_CONFIDENCES.has(data.confidence)) {
      throw new Error(`Invalid confidence: "${data.confidence}"`);
    }
    fields.push("confidence = ?");
    values.push(data.confidence);
  }
  if (data.notes !== undefined) {
    fields.push("notes = ?");
    values.push(data.notes || null);
  }

  if (fields.length > 0) {
    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(contactId);
    db.prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  const updated = db
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(contactId) as Record<string, unknown>;
  return rowToAdminContact(updated);
}

/**
 * Delete a contact record.
 *
 * @param db - Contacts database instance.
 * @param contactId - Contact ID.
 * @returns True if deleted, false if not found.
 */
export function deleteManufacturerContact(
  db: DatabaseType,
  contactId: number,
  manufacturerId?: number
): boolean {
  if (manufacturerId !== undefined) {
    const result = db.prepare("DELETE FROM contacts WHERE id = ? AND manufacturer_id = ?").run(contactId, manufacturerId);
    return result.changes > 0;
  }
  const result = db.prepare("DELETE FROM contacts WHERE id = ?").run(contactId);
  return result.changes > 0;
}
