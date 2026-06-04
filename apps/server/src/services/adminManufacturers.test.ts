/**
 * Tests for the admin manufacturer contacts service.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestContactsDb, seedManufacturer, seedContact } from "../test/dbHelper";
import {
  getManufacturerContactsByName,
  addManufacturerContact,
  updateManufacturerContact,
  deleteManufacturerContact,
} from "./adminManufacturers";

let db: DatabaseType;

beforeEach(() => {
  db = createTestContactsDb();
});

describe("getManufacturerContactsByName", () => {
  it("returns manufacturer with contacts by exact name", () => {
    const mfgId = seedManufacturer(db, "Sony", 10);
    seedContact(db, mfgId, { contactType: "media", email: "media@sony.com", confidence: "high" });
    seedContact(db, mfgId, { contactType: "pr", email: "pr@sony.com", confidence: "medium" });

    const result = getManufacturerContactsByName(db, "Sony");
    expect(result).not.toBeNull();
    expect(result!.manufacturer.name).toBe("Sony");
    expect(result!.manufacturer.productCount).toBe(10);
    expect(result!.contacts).toHaveLength(2);
    // High confidence should come first
    expect(result!.contacts[0].confidence).toBe("high");
  });

  it("performs case-insensitive lookup", () => {
    seedManufacturer(db, "Samsung", 5);
    const result = getManufacturerContactsByName(db, "samsung");
    expect(result).not.toBeNull();
    expect(result!.manufacturer.name).toBe("Samsung");
  });

  it("performs case-insensitive lookup with mixed case", () => {
    seedManufacturer(db, "Sony", 3);
    const result = getManufacturerContactsByName(db, "SONY");
    expect(result).not.toBeNull();
  });

  it("returns null for unknown manufacturer", () => {
    const result = getManufacturerContactsByName(db, "NonExistent Corp");
    expect(result).toBeNull();
  });

  it("returns empty contacts array when manufacturer has none", () => {
    seedManufacturer(db, "NewBrand", 1);
    const result = getManufacturerContactsByName(db, "NewBrand");
    expect(result).not.toBeNull();
    expect(result!.contacts).toEqual([]);
  });
});

describe("addManufacturerContact", () => {
  it("adds a contact with required fields", () => {
    const mfgId = seedManufacturer(db, "Nike", 20);
    const contact = addManufacturerContact(db, mfgId, {
      contactType: "media",
      confidence: "high",
      email: "press@nike.com",
    });

    expect(contact.id).toBeDefined();
    expect(contact.manufacturerId).toBe(mfgId);
    expect(contact.contactType).toBe("media");
    expect(contact.confidence).toBe("high");
    expect(contact.email).toBe("press@nike.com");
  });

  it("adds a contact with all optional fields", () => {
    const mfgId = seedManufacturer(db, "Bose", 8);
    const contact = addManufacturerContact(db, mfgId, {
      contactType: "partnerships",
      confidence: "medium",
      email: "partner@bose.com",
      phone: "555-1234",
      contactPageUrl: "https://bose.com/contact",
      sourceUrl: "https://bose.com/about",
      notes: "Test note",
    });

    expect(contact.phone).toBe("555-1234");
    expect(contact.contactPageUrl).toBe("https://bose.com/contact");
    expect(contact.sourceUrl).toBe("https://bose.com/about");
    expect(contact.notes).toBe("Test note");
  });

  it("throws for invalid contactType", () => {
    const mfgId = seedManufacturer(db, "Test", 1);
    expect(() =>
      addManufacturerContact(db, mfgId, {
        contactType: "invalid",
        confidence: "high",
      })
    ).toThrow("Invalid contactType");
  });

  it("throws for invalid confidence", () => {
    const mfgId = seedManufacturer(db, "Test", 1);
    expect(() =>
      addManufacturerContact(db, mfgId, {
        contactType: "general",
        confidence: "very-high",
      })
    ).toThrow("Invalid confidence");
  });

  it("throws for non-existent manufacturer", () => {
    expect(() =>
      addManufacturerContact(db, 9999, {
        contactType: "general",
        confidence: "medium",
      })
    ).toThrow("Manufacturer not found");
  });
});

describe("updateManufacturerContact", () => {
  it("updates contact fields", () => {
    const mfgId = seedManufacturer(db, "Sony", 5);
    const contactId = seedContact(db, mfgId, {
      contactType: "general",
      email: "old@sony.com",
      confidence: "low",
    });

    const updated = updateManufacturerContact(db, contactId, {
      email: "new@sony.com",
      confidence: "high",
    });

    expect(updated).not.toBeNull();
    expect(updated!.email).toBe("new@sony.com");
    expect(updated!.confidence).toBe("high");
    expect(updated!.contactType).toBe("general"); // unchanged
  });

  it("updates contactType", () => {
    const mfgId = seedManufacturer(db, "Test", 1);
    const contactId = seedContact(db, mfgId, { contactType: "general", confidence: "medium" });

    const updated = updateManufacturerContact(db, contactId, { contactType: "media" });
    expect(updated!.contactType).toBe("media");
  });

  it("returns null for non-existent contact", () => {
    const result = updateManufacturerContact(db, 9999, { email: "x@y.com" });
    expect(result).toBeNull();
  });

  it("throws for invalid contactType", () => {
    const mfgId = seedManufacturer(db, "Test", 1);
    const contactId = seedContact(db, mfgId, { contactType: "general", confidence: "medium" });

    expect(() =>
      updateManufacturerContact(db, contactId, { contactType: "bogus" })
    ).toThrow("Invalid contactType");
  });

  it("throws for invalid confidence", () => {
    const mfgId = seedManufacturer(db, "Test", 1);
    const contactId = seedContact(db, mfgId, { contactType: "general", confidence: "medium" });

    expect(() =>
      updateManufacturerContact(db, contactId, { confidence: "extreme" })
    ).toThrow("Invalid confidence");
  });
});

describe("deleteManufacturerContact", () => {
  it("deletes an existing contact", () => {
    const mfgId = seedManufacturer(db, "Sony", 5);
    const contactId = seedContact(db, mfgId, { contactType: "general", confidence: "medium" });

    const result = deleteManufacturerContact(db, contactId);
    expect(result).toBe(true);

    // Verify it's gone
    const check = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId);
    expect(check).toBeUndefined();
  });

  it("returns false for non-existent contact", () => {
    const result = deleteManufacturerContact(db, 9999);
    expect(result).toBe(false);
  });
});
