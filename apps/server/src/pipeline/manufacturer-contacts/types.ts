/**
 * Shared types for the manufacturer contacts pipeline.
 *
 * This pipeline extracts manufacturer/brand information from product data
 * and searches the web for contact information (especially media/PR emails).
 */

/** Contact category for a manufacturer. */
export type ContactType =
  | "media"
  | "promotions"
  | "pr"
  | "partnerships"
  | "general"
  | "support";

/** Confidence level for extracted or searched data. */
export type Confidence = "high" | "medium" | "low";

/** Search status for a manufacturer in the pipeline. */
export type SearchStatus = "pending" | "searched" | "verified";

/** A manufacturer/brand record in the contacts database. */
export interface Manufacturer {
  id: number;
  name: string;
  normalizedName: string;
  website: string | null;
  productCount: number;
  searchStatus: SearchStatus;
  createdAt: string;
  updatedAt: string;
}

/** A contact record linked to a manufacturer. */
export interface Contact {
  id: number;
  manufacturerId: number;
  contactType: ContactType;
  email: string | null;
  phone: string | null;
  contactPageUrl: string | null;
  sourceUrl: string | null;
  confidence: Confidence;
  notes: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A search log entry tracking web searches performed. */
export interface SearchLogEntry {
  id: number;
  manufacturerId: number;
  query: string;
  source: string;
  resultsFound: number;
  searchedAt: string;
}

/** Result of extracting a manufacturer from a product title. */
export interface ManufacturerExtraction {
  productId: number;
  productTitle: string;
  asin: string;
  manufacturer: string;
  confidence: Confidence;
}

/** Input for inserting a new contact. */
export interface ContactInput {
  contactType: ContactType;
  email?: string;
  phone?: string;
  contactPageUrl?: string;
  sourceUrl?: string;
  confidence: Confidence;
  notes?: string;
}

/** Result returned from a contact web search (before DB insertion). */
export interface ContactSearchResult {
  manufacturer: string;
  website?: string;
  contacts: ContactInput[];
}

/** Row shape from the products table in the main game database. */
export interface ProductRow {
  id: number;
  asin: string;
  title: string;
  category: string;
  manufacturer?: string | null;
}

/** Backup manifest for the contacts database. */
export interface BackupManifest {
  backedUpAt: string;
  totalManufacturers: number;
  totalContacts: number;
  totalSearchLogs: number;
  version: number;
}
