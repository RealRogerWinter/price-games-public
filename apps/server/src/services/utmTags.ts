/**
 * UTM tag management service — CRUD and per-tag conversion funnel.
 *
 * A "UTM tag" is an admin-authored preset encoding a
 * `(utm_source, utm_medium, utm_campaign, utm_content, utm_term)` tuple
 * plus a destination URL. Admins copy the generated long URL to paste
 * into ads/posts. Results are computed from the existing `users.utm_*`
 * columns captured at signup (migration v28).
 */

import { randomUUID } from "crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { customAlphabet } from "nanoid";
import {
  ADMIN_TIMEZONE,
  enumerateDaysInRange,
  tzDateString,
  wilsonInterval,
  wilsonCompare,
  type WilsonInterval,
} from "@price-game/shared";
import { getPromoBanner } from "./siteSettings";

// === Types ===

/** A UTM tag preset as returned by the service layer (camelCase). */
export interface UtmTag {
  id: string;
  name: string;
  utmSource: string;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  destinationUrl: string;
  status: UtmTagStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  /** Optional short code that maps to a `/go/:code` public redirect. */
  shortCode: string | null;
  /** Number of times the short-link redirect has served this tag. */
  clickCount: number;
  /** ISO timestamp of the most recent short-link hit, or null if never. */
  lastClickedAt: string | null;
  /**
   * Origin identifier for system-managed tags created by the outbound-links
   * service (one per email/push template type). Null for admin-created tags.
   * System tags are read-only in the admin UI and refuse update/delete.
   */
  originKey: string | null;
}

export type UtmTagStatus = "active" | "archived";

/** Conversion funnel counts for a single UTM tag. */
export interface UtmTagStats {
  tagId: string;
  signups: number;
  playedFirstGame: number;
  giveawayEligible: number;
  wonReward: number;
  /**
   * Score threshold used for the giveaway-eligible step, read from
   * `site_settings.promo_banner.giveawayMinPoints`.
   */
  giveawayThreshold: number;
  /**
   * Short-link redirect hit count. Always 0 when the tag has no short code.
   * The UI uses {@link hasShortCode} to decide whether to render a "Clicks"
   * row on the funnel.
   */
  clicks: number;
  /** True when the tag has a non-null `shortCode` — hint for UI layout. */
  hasShortCode: boolean;
  /**
   * Number of anonymous visitors (visitor_attribution rows with no
   * claimed_user_id) matching this tag's UTM tuple who have played at
   * least one game. Counts the "played before signup" cohort that the
   * users-table-based `playedFirstGame` metric cannot see.
   */
  anonymousPlays: number;
}

/** Fields accepted when creating or updating a UTM tag. */
export interface UtmTagInput {
  name?: string;
  utmSource?: string;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  destinationUrl?: string;
  /**
   * Optional short code. Empty string and null both clear the code on update.
   * Undefined leaves the existing value unchanged.
   */
  shortCode?: string | null;
}

interface UtmTagRow {
  id: string;
  name: string;
  utm_source: string;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  destination_url: string;
  status: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  short_code: string | null;
  click_count: number;
  last_clicked_at: string | null;
  origin_key: string | null;
}

interface CountRow {
  count: number;
}

// === Constants ===

const MAX_NAME_LENGTH = 200;
const MAX_UTM_FIELD_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const VALID_STATUSES = new Set<UtmTagStatus>(["active", "archived"]);
const VALID_LIST_FILTERS = new Set(["all", "active", "archived"]);
/**
 * Origin filter for `listUtmTags`. Defaults to `admin` so the admin UI
 * doesn't get spammed with the system-managed origin rows that the
 * outbound-links service creates per email/push template.
 */
const VALID_ORIGIN_FILTERS = new Set(["admin", "system", "all"]);

const SHORT_CODE_MIN_LENGTH = 3;
const SHORT_CODE_MAX_LENGTH = 32;
// Lowercase letters, digits, hyphens; must start and end with a non-hyphen.
const SHORT_CODE_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SHORT_CODE_ERROR_MESSAGE =
  "Short code must be 3-32 lowercase letters, digits, or hyphens (no leading or trailing hyphen)";
const SHORT_CODE_DUPLICATE_ERROR_MESSAGE =
  "A UTM tag with this short code already exists";

// nanoid alphabet restricted to lowercase alphanumeric so suggestions pass
// validateShortCode on the first try. Excluding hyphens avoids leading /
// trailing hyphen collisions; 6 chars → ~2.1 B combinations, collision risk
// is effectively zero for realistic admin use.
const shortCodeNanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 6);

// === Mapping ===

function mapRow(row: UtmTagRow): UtmTag {
  return {
    id: row.id,
    name: row.name,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    utmTerm: row.utm_term,
    destinationUrl: row.destination_url,
    status: row.status as UtmTagStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    shortCode: row.short_code,
    clickCount: row.click_count,
    lastClickedAt: row.last_clicked_at,
    originKey: row.origin_key,
  };
}

// === Validation helpers ===

/**
 * Normalize a string input: trim, and return null if empty.
 * Used for optional UTM fields so callers can pass "" and get null.
 */
function normalizeOptional(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Validate and normalize an optional UTM field value. */
function validateOptionalUtmField(value: string | null | undefined): string | null {
  const normalized = normalizeOptional(value);
  if (normalized === null) return null;
  if (normalized.length > MAX_UTM_FIELD_LENGTH) {
    throw new Error(`UTM field exceeds maximum length of ${MAX_UTM_FIELD_LENGTH} characters`);
  }
  return normalized;
}

/** Validate a name: required, trimmed, 1–200 chars. */
function validateName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("UTM tag name is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`UTM tag name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

/** Validate utm_source: required, trimmed, 1–128 chars. */
function validateUtmSource(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("utm_source is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_UTM_FIELD_LENGTH) {
    throw new Error(`utm_source exceeds maximum length of ${MAX_UTM_FIELD_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * Validate and normalize an optional short code.
 *
 * Normalization:
 *   - null / undefined → null
 *   - empty or whitespace-only → null
 *   - otherwise: trimmed and lowercased
 *
 * Validation (applied after normalization to any non-null result):
 *   - length 3–32 characters
 *   - only lowercase letters, digits, and hyphens
 *   - must not start or end with a hyphen
 *
 * @param value - Raw input from an admin form.
 * @returns The normalized short code, or null if absent.
 * @throws Error on validation failure.
 */
export function validateShortCode(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error(SHORT_CODE_ERROR_MESSAGE);
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (
    trimmed.length < SHORT_CODE_MIN_LENGTH ||
    trimmed.length > SHORT_CODE_MAX_LENGTH ||
    !SHORT_CODE_REGEX.test(trimmed)
  ) {
    throw new Error(SHORT_CODE_ERROR_MESSAGE);
  }
  return trimmed;
}

/**
 * Validate a destination URL: must be either a root-relative path (starting
 * with `/`) or an absolute HTTP(S) URL. Rejects `javascript:`, `data:`,
 * `ftp:`, and other schemes to prevent admins from pasting dangerous links.
 */
function validateDestinationUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Destination URL is required");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new Error(`Destination URL exceeds maximum length of ${MAX_URL_LENGTH} characters`);
  }
  // Root-relative path.
  if (trimmed.startsWith("/")) {
    // A single leading slash only — reject protocol-relative "//host".
    if (trimmed.startsWith("//")) {
      throw new Error("Destination URL must be an HTTP(S) URL or path starting with /");
    }
    return trimmed;
  }
  // Absolute HTTP(S) URL.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      // Throws on invalid URL.
      // eslint-disable-next-line no-new
      new URL(trimmed);
      return trimmed;
    } catch {
      throw new Error("Destination URL must be an HTTP(S) URL or path starting with /");
    }
  }
  throw new Error("Destination URL must be an HTTP(S) URL or path starting with /");
}

// === CRUD ===

/**
 * Create a new UTM tag preset.
 *
 * @param db - Database instance.
 * @param input - Tag fields. Unknown keys are ignored.
 * @param adminId - ID of the admin creating the tag, or null for seeds.
 * @returns The created tag.
 * @throws Error on validation failure or duplicate name.
 */
export function createUtmTag(
  db: DatabaseType,
  input: UtmTagInput,
  adminId: string | null,
): UtmTag {
  const name = validateName(input.name);
  const utmSource = validateUtmSource(input.utmSource);
  const utmMedium = validateOptionalUtmField(input.utmMedium);
  const utmCampaign = validateOptionalUtmField(input.utmCampaign);
  const utmContent = validateOptionalUtmField(input.utmContent);
  const utmTerm = validateOptionalUtmField(input.utmTerm);
  const destinationUrl = validateDestinationUrl(input.destinationUrl);
  const shortCode = validateShortCode(input.shortCode);

  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO utm_tags
        (id, name, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         destination_url, status, created_at, updated_at, created_by, short_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      destinationUrl,
      now,
      now,
      adminId,
      shortCode,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      // Disambiguate name vs short-code collision by the column referenced.
      if (err.message.includes("utm_tags.short_code") || err.message.includes("idx_utm_tags_short_code")) {
        throw new Error(SHORT_CODE_DUPLICATE_ERROR_MESSAGE);
      }
      throw new Error("A UTM tag with this name already exists");
    }
    throw err;
  }

  return {
    id,
    name,
    utmSource,
    utmMedium,
    utmCampaign,
    utmContent,
    utmTerm,
    destinationUrl,
    status: "active",
    createdAt: now,
    updatedAt: now,
    createdBy: adminId,
    shortCode,
    clickCount: 0,
    lastClickedAt: null,
    originKey: null,
  };
}

/**
 * Fetch a single UTM tag by id.
 *
 * @param db - Database instance.
 * @param id - The tag id.
 * @returns The tag, or null if not found.
 */
export function getUtmTag(db: DatabaseType, id: string): UtmTag | null {
  const row = db.prepare("SELECT * FROM utm_tags WHERE id = ?").get(id) as UtmTagRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * List UTM tags with pagination, status filter, and origin filter.
 *
 * @param db - Database instance.
 * @param params - Pagination + filter options.
 *   - `status`: 'active' (default) | 'archived' | 'all'.
 *   - `origin`: 'admin' (default; admin-created rows only) | 'system'
 *     (rows materialized by the outbound-links service) | 'all'.
 * @returns Paginated tag list.
 * @throws Error if `status` or `origin` is invalid.
 */
export function listUtmTags(
  db: DatabaseType,
  params: { page?: number; pageSize?: number; status?: string; origin?: string },
): { tags: UtmTag[]; total: number; page: number; pageSize: number; totalPages: number } {
  const statusFilter = params.status ?? "active";
  if (!VALID_LIST_FILTERS.has(statusFilter)) {
    throw new Error("Invalid status filter");
  }
  const originFilter = params.origin ?? "admin";
  if (!VALID_ORIGIN_FILTERS.has(originFilter)) {
    throw new Error("Invalid origin filter");
  }

  const page = Math.max(1, params.page || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize || DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const whereParams: unknown[] = [];
  if (statusFilter !== "all") {
    conditions.push("status = ?");
    whereParams.push(statusFilter);
  }
  if (originFilter === "admin") {
    conditions.push("origin_key IS NULL");
  } else if (originFilter === "system") {
    conditions.push("origin_key IS NOT NULL");
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM utm_tags ${whereClause}`)
    .get(...whereParams) as CountRow;
  const total = totalRow.count;

  const rows = db
    .prepare(
      `SELECT * FROM utm_tags
       ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...whereParams, pageSize, offset) as UtmTagRow[];

  return {
    tags: rows.map(mapRow),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * Update mutable fields on a UTM tag. Unset fields are left unchanged.
 *
 * @param db - Database instance.
 * @param id - The tag id.
 * @param input - Partial fields to update.
 * @returns The updated tag, or null if no row with that id exists.
 * @throws Error on validation failure or duplicate name.
 */
export function updateUtmTag(
  db: DatabaseType,
  id: string,
  input: UtmTagInput,
): UtmTag | null {
  const existing = db.prepare("SELECT * FROM utm_tags WHERE id = ?").get(id) as
    | UtmTagRow
    | undefined;
  if (!existing) return null;

  // System-managed origin rows are read-only — the outbound-links service
  // writes them once and depends on the (origin_key, destination_url) tuple
  // staying stable so the in-memory short-code cache doesn't go stale.
  if (existing.origin_key !== null) {
    throw new Error("Cannot update system-managed UTM tag");
  }

  const name = input.name !== undefined ? validateName(input.name) : existing.name;
  const utmSource =
    input.utmSource !== undefined ? validateUtmSource(input.utmSource) : existing.utm_source;
  const utmMedium =
    input.utmMedium !== undefined
      ? validateOptionalUtmField(input.utmMedium)
      : existing.utm_medium;
  const utmCampaign =
    input.utmCampaign !== undefined
      ? validateOptionalUtmField(input.utmCampaign)
      : existing.utm_campaign;
  const utmContent =
    input.utmContent !== undefined
      ? validateOptionalUtmField(input.utmContent)
      : existing.utm_content;
  const utmTerm =
    input.utmTerm !== undefined ? validateOptionalUtmField(input.utmTerm) : existing.utm_term;
  const destinationUrl =
    input.destinationUrl !== undefined
      ? validateDestinationUrl(input.destinationUrl)
      : existing.destination_url;
  const shortCode =
    input.shortCode !== undefined ? validateShortCode(input.shortCode) : existing.short_code;

  const now = new Date().toISOString();

  try {
    db.prepare(
      `UPDATE utm_tags
       SET name = ?, utm_source = ?, utm_medium = ?, utm_campaign = ?,
           utm_content = ?, utm_term = ?, destination_url = ?, short_code = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      destinationUrl,
      shortCode,
      now,
      id,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      if (err.message.includes("utm_tags.short_code") || err.message.includes("idx_utm_tags_short_code")) {
        throw new Error(SHORT_CODE_DUPLICATE_ERROR_MESSAGE);
      }
      throw new Error("A UTM tag with this name already exists");
    }
    throw err;
  }

  return getUtmTag(db, id);
}

/**
 * Set the lifecycle status of a UTM tag.
 *
 * @param db - Database instance.
 * @param id - The tag id.
 * @param status - The new status ('active' or 'archived').
 * @returns The updated tag, or null if no row with that id exists.
 * @throws Error if `status` is not a valid value.
 */
export function setUtmTagStatus(
  db: DatabaseType,
  id: string,
  status: UtmTagStatus,
): UtmTag | null {
  if (!VALID_STATUSES.has(status)) {
    throw new Error("Invalid status");
  }
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE utm_tags SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now, id);
  if (result.changes === 0) return null;
  return getUtmTag(db, id);
}

/**
 * Hard-delete a UTM tag. Refuses if any user row matches the tag's UTM
 * tuple — those historical signups would lose their display label.
 *
 * @param db - Database instance.
 * @param id - The tag id.
 * @returns true if the row was deleted, false if no such id.
 * @throws Error "Cannot delete UTM tag with matched signups" if any signup matches.
 */
export function deleteUtmTag(db: DatabaseType, id: string): boolean {
  const existing = db.prepare("SELECT * FROM utm_tags WHERE id = ?").get(id) as
    | UtmTagRow
    | undefined;
  if (!existing) return false;

  // System-managed origin rows back the outbound-links short-code cache;
  // deleting one would 404 every link in flight from the corresponding
  // email/push template until the next service-process restart.
  if (existing.origin_key !== null) {
    throw new Error("Cannot delete system-managed UTM tag");
  }

  if (countMatchingSignups(db, existing) > 0) {
    throw new Error("Cannot delete UTM tag with matched signups");
  }

  const result = db.prepare("DELETE FROM utm_tags WHERE id = ?").run(id);
  return result.changes > 0;
}

// === URL building ===

/**
 * Build the shareable URL for a UTM tag. Appends every non-null, non-empty
 * UTM field to the destination URL as a query parameter. Pre-existing
 * non-UTM query params on the destination are preserved; pre-existing
 * UTM params are overwritten by the tag's values.
 *
 * @param tag - The tag (or a subset with the required fields).
 * @param baseUrl - The site origin to use when the destination is root-relative
 *   (e.g. `https://pricegames.app`). Ignored for absolute destinations.
 * @returns The generated URL.
 */
export function buildTagUrl(
  tag: Pick<
    UtmTag,
    "utmSource" | "utmMedium" | "utmCampaign" | "utmContent" | "utmTerm" | "destinationUrl"
  >,
  baseUrl: string,
): string {
  const url = new URL(tag.destinationUrl, baseUrl);
  const setIfPresent = (key: string, value: string | null | undefined) => {
    if (value && value.length > 0) url.searchParams.set(key, value);
  };
  setIfPresent("utm_source", tag.utmSource);
  setIfPresent("utm_medium", tag.utmMedium);
  setIfPresent("utm_campaign", tag.utmCampaign);
  setIfPresent("utm_content", tag.utmContent);
  setIfPresent("utm_term", tag.utmTerm);
  return url.toString();
}

/**
 * Build the public short-link URL for a tag, or null if it has no code.
 *
 * @param tag - Any object exposing a `shortCode` field.
 * @param baseUrl - Site origin (e.g. `https://pricegames.app`). A single
 *   trailing slash is tolerated and stripped.
 * @returns `${baseUrl}/go/${shortCode}`, or null if `shortCode` is null.
 */
export function buildShortUrl(
  tag: { shortCode: string | null },
  baseUrl: string,
): string | null {
  if (!tag.shortCode) return null;
  const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmedBase}/go/${tag.shortCode}`;
}

// === Short-link click recording ===

/**
 * Atomically increment the click counter and update the last-clicked
 * timestamp for the tag whose `short_code` matches `code`, returning the
 * updated row. Uses a single SQL `UPDATE ... RETURNING` so concurrent
 * redirect handlers cannot race each other.
 *
 * Archived tags are intentionally still counted: marketing URLs live on
 * after a campaign ends and breaking old printed QR codes would be worse
 * than the slight noise in the funnel.
 *
 * @param db - Database instance.
 * @param code - The exact short code to match (caller must lowercase).
 * @returns The updated tag, or null if no row matched.
 */
export function recordShortCodeClick(db: DatabaseType, code: string): UtmTag | null {
  if (!code) return null;
  const now = new Date().toISOString();
  const row = db
    .prepare(
      `UPDATE utm_tags
       SET click_count = click_count + 1,
           last_clicked_at = ?
       WHERE short_code = ?
       RETURNING *`,
    )
    .get(now, code) as UtmTagRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Return a short-code suggestion that is guaranteed not to collide with any
 * currently-stored non-null `short_code`. Retries up to 5 times on collision;
 * beyond that, the collision probability is effectively zero for any
 * realistic dataset (6 chars over a 36-char alphabet ≈ 2.1 B combinations).
 *
 * @param db - Database instance.
 * @returns A valid short code that passes {@link validateShortCode}.
 * @throws Error only in the pathological case of 5 consecutive collisions.
 */
export function generateShortCodeSuggestion(db: DatabaseType): string {
  const lookup = db.prepare("SELECT 1 FROM utm_tags WHERE short_code = ?");
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = shortCodeNanoid();
    if (!lookup.get(candidate)) return candidate;
  }
  throw new Error("Unable to generate a unique short code suggestion");
}

// === Funnel stats ===

/**
 * Build the WHERE clause fragment + bind params for matching users by
 * a tag's UTM tuple. Exact-tuple match: a NULL optional field on the tag
 * requires the user's column to also be NULL (not "any value").
 *
 * Wildcard semantics caused funnel double-counting whenever two tags
 * shared a `utm_source` but differed in optional fields — every signup
 * attributed to the narrower tag was also counted under the broader one.
 */
function buildCohortWhere(tag: UtmTagRow): { clause: string; params: unknown[] } {
  return buildAliasCohortWhere(tag, "u");
}

/**
 * Same as {@link buildCohortWhere} but aliased for the visitor_attribution
 * table (`v.*` instead of `u.*`). Kept separate so the users cohort query
 * doesn't need a join it doesn't want.
 */
function buildVisitorCohortWhere(
  tag: UtmTagRow,
): { clause: string; params: unknown[] } {
  return buildAliasCohortWhere(tag, "v");
}

/**
 * Shared cohort WHERE-clause builder. The `alias` selects the table prefix
 * (`u` for `users`, `v` for `visitor_attribution`); the predicate semantics
 * are identical for both.
 */
function buildAliasCohortWhere(
  tag: UtmTagRow,
  alias: "u" | "v",
): { clause: string; params: unknown[] } {
  const clauses: string[] = [`${alias}.utm_source = ?`];
  const params: unknown[] = [tag.utm_source];

  const optional: Array<["utm_medium" | "utm_campaign" | "utm_content" | "utm_term", string | null]> = [
    ["utm_medium", tag.utm_medium],
    ["utm_campaign", tag.utm_campaign],
    ["utm_content", tag.utm_content],
    ["utm_term", tag.utm_term],
  ];
  for (const [column, value] of optional) {
    if (value !== null) {
      clauses.push(`${alias}.${column} = ?`);
      params.push(value);
    } else {
      clauses.push(`${alias}.${column} IS NULL`);
    }
  }
  return { clause: clauses.join(" AND "), params };
}

/** Count users whose attribution matches the tag's UTM tuple. */
function countMatchingSignups(db: DatabaseType, tag: UtmTagRow): number {
  const { clause, params } = buildCohortWhere(tag);
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM users u WHERE ${clause}`)
    .get(...params) as CountRow;
  return row.count;
}

/**
 * Options accepted by {@link getUtmTagStats} to optionally restrict the
 * funnel to a trailing window. Omit `rangeDays` for the lifetime view
 * (existing behavior, used by the per-tag funnel UI by default).
 */
export interface GetUtmTagStatsOpts {
  /** Trailing window in days (e.g. 7, 28, 90). Omit for lifetime. */
  rangeDays?: number;
  /** Epoch ms; defaults to Date.now(). Exposed for test determinism. */
  now?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the 4-stage conversion funnel for a UTM tag:
 *   1. signups            — users whose attribution matches the tag's UTM tuple
 *   2. playedFirstGame    — of those, who have at least one user_game_history row
 *   3. giveawayEligible   — of those, whose lifetime_score >= giveawayMinPoints
 *   4. wonReward          — of those, who have at least one reward_awards row
 *
 * The giveaway threshold is read from `site_settings.promo_banner.giveawayMinPoints`
 * via {@link getPromoBanner}.
 *
 * When `opts.rangeDays` is provided, the funnel is restricted to users whose
 * `users.created_at` falls inside the trailing window and to anonymous-play
 * visitors whose `first_game_at` falls inside the window. Lifetime click
 * count is always reported as-is (no per-click time data).
 *
 * @param db - Database instance.
 * @param id - The UTM tag id.
 * @param opts - Optional range/now overrides. Omit for lifetime.
 * @returns Funnel counts + threshold, or null if no tag with that id exists.
 */
export function getUtmTagStats(
  db: DatabaseType,
  id: string,
  opts: GetUtmTagStatsOpts = {},
): UtmTagStats | null {
  const tag = db.prepare("SELECT * FROM utm_tags WHERE id = ?").get(id) as UtmTagRow | undefined;
  if (!tag) return null;

  const banner = getPromoBanner(db);
  const threshold = banner.giveawayMinPoints;

  const now = opts.now ?? Date.now();
  // ISO string lower bound for `users.created_at` and `visitor_attribution.first_game_at`,
  // both of which are stored as ISO TEXT. ISO strings sort lexicographically
  // when normalized so a `>=` comparison is correct.
  const sinceIso =
    typeof opts.rangeDays === "number" && opts.rangeDays > 0
      ? new Date(now - opts.rangeDays * DAY_MS).toISOString()
      : null;

  const { clause, params } = buildCohortWhere(tag);
  // When a range is set, append `u.created_at >= ?` to the cohort WHERE.
  const userClause = sinceIso ? `${clause} AND u.created_at >= ?` : clause;
  const userParams = sinceIso ? [...params, sinceIso] : params;
  const row = db
    .prepare(
      `SELECT
        COUNT(DISTINCT u.id) AS signups,
        COUNT(DISTINCT CASE
          WHEN EXISTS (SELECT 1 FROM user_game_history h WHERE h.user_id = u.id)
          THEN u.id END) AS played_first_game,
        COUNT(DISTINCT CASE
          WHEN u.lifetime_score >= ?
          THEN u.id END) AS giveaway_eligible,
        COUNT(DISTINCT CASE
          WHEN EXISTS (SELECT 1 FROM reward_awards ra WHERE ra.user_id = u.id)
          THEN u.id END) AS won_reward
       FROM users u
       WHERE ${userClause}`,
    )
    .get(threshold, ...userParams) as {
    signups: number;
    played_first_game: number;
    giveaway_eligible: number;
    won_reward: number;
  };

  // hasShortCode drives whether the funnel UI renders a top "Clicks" row.
  // clicks is the existing per-tag counter — 0 for tags without a short code.
  // Lifetime regardless of `rangeDays` because the redirect handler
  // intentionally does not log per-click events (see shortLinks.ts privacy
  // comment); per-day click time-series is a v2 follow-up.
  const hasShortCode = tag.short_code !== null;
  const clicks = hasShortCode ? tag.click_count : 0;

  // Count anonymous (unclaimed) visitors matching the tuple who have played
  // at least one game. Excludes claimed_user_id IS NOT NULL so that a
  // visitor who later signed up is counted under `playedFirstGame` or
  // `signups` instead — no double-counting across the funnel.
  const visitorCohort = buildVisitorCohortWhere(tag);
  const visitorClause = sinceIso
    ? `${visitorCohort.clause} AND v.first_game_at >= ?`
    : visitorCohort.clause;
  const visitorParams = sinceIso ? [...visitorCohort.params, sinceIso] : visitorCohort.params;
  const anonRow = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM visitor_attribution v
        WHERE ${visitorClause}
          AND v.first_game_at IS NOT NULL
          AND v.claimed_user_id IS NULL`,
    )
    .get(...visitorParams) as CountRow;

  return {
    tagId: tag.id,
    signups: row.signups,
    playedFirstGame: row.played_first_game,
    giveawayEligible: row.giveaway_eligible,
    wonReward: row.won_reward,
    giveawayThreshold: threshold,
    clicks,
    hasShortCode,
    anonymousPlays: anonRow.count,
  };
}

// === Time series ===

/** One bucket of the per-tag daily traffic series. */
export interface UtmTagTimeSeriesPoint {
  /** YYYY-MM-DD in admin TZ (default America/Los_Angeles). */
  date: string;
  /** Sessions whose entry matches the tag's 3-tuple, bot-filtered. */
  sessions: number;
  /** Signups whose user.utm_* tuple matches the tag's 5-tuple. */
  signups: number;
  /** Unclaimed visitors whose first_game_at lands in the bucket. */
  anonymousPlays: number;
}

/** Internal: parse `entry_*` UTM cohort against analytics_sessions. */
function buildSessionCohortClause(
  tag: UtmTagRow,
): { clause: string; params: unknown[] } {
  // 3-tuple match. analytics_sessions does not carry entry_utm_content
  // or entry_utm_term, so we cannot honor those parts of the tag tuple
  // at the session level. The user-side cohort still uses the full
  // 5-tuple. See ARCHITECTURE for the asymmetry note.
  const clauses: string[] = ["s.entry_utm_source = ?"];
  const params: unknown[] = [tag.utm_source];
  for (const [column, value] of [
    ["entry_utm_medium", tag.utm_medium],
    ["entry_utm_campaign", tag.utm_campaign],
  ] as Array<["entry_utm_medium" | "entry_utm_campaign", string | null]>) {
    if (value !== null) {
      clauses.push(`s.${column} = ?`);
      params.push(value);
    } else {
      clauses.push(`s.${column} IS NULL`);
    }
  }
  return { clause: clauses.join(" AND "), params };
}

/**
 * Daily series for a single UTM tag over the given trailing window.
 *
 * Sessions are bucketed by `analytics_sessions.started_at` in admin TZ
 * (default {@link ADMIN_TIMEZONE}); signups by `users.created_at`;
 * anonymous plays by `visitor_attribution.first_game_at`. The output
 * has one point per day in the window, zero-filled. Today's bucket is
 * included even if partial — the UI marks it as "in progress."
 *
 * Cohort match: 3-tuple `(source, medium, campaign)` against sessions,
 * 5-tuple against users + visitors (matching `getUtmTagStats`).
 *
 * @param db - Database instance.
 * @param id - The UTM tag id.
 * @param rangeDays - Trailing window in days (e.g. 7, 28, 90).
 * @param now - Epoch ms; defaults to Date.now() (exposed for tests).
 * @param timeZone - IANA timezone identifier; defaults to admin TZ.
 * @returns Daily points or null if no tag with that id exists.
 */
export function getUtmTagTimeSeries(
  db: DatabaseType,
  id: string,
  rangeDays: number,
  now: number = Date.now(),
  timeZone: string = ADMIN_TIMEZONE,
): UtmTagTimeSeriesPoint[] | null {
  const tag = db
    .prepare("SELECT * FROM utm_tags WHERE id = ?")
    .get(id) as UtmTagRow | undefined;
  if (!tag) return null;

  const sinceMs = now - rangeDays * DAY_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  const days = enumerateDaysInRange(new Date(sinceMs), new Date(now), timeZone);

  // Initialize the zero-filled buckets in declared order so the result
  // array is always sorted ascending and never has gaps.
  const byDate = new Map<string, UtmTagTimeSeriesPoint>();
  for (const date of days) {
    byDate.set(date, { date, sessions: 0, signups: 0, anonymousPlays: 0 });
  }

  // --- Sessions ---
  // Use ms-epoch column directly so we can convert to admin-TZ date in JS
  // (sqlite has no IANA tz support). Aggregating in SQL by raw started_at
  // would emit 1 row per session — fine at our scale, and lets the JS
  // bucketer handle the DST math without us re-implementing it in SQL.
  const sessionCohort = buildSessionCohortClause(tag);
  const sessionRows = db
    .prepare(
      `SELECT started_at AS ts
         FROM analytics_sessions s
        WHERE ${sessionCohort.clause}
          AND s.is_bot = 0
          AND s.started_at >= ?`,
    )
    .all(...sessionCohort.params, sinceMs) as Array<{ ts: number }>;
  for (const row of sessionRows) {
    const date = tzDateString(new Date(row.ts).toISOString(), timeZone);
    const bucket = byDate.get(date);
    if (bucket) bucket.sessions++;
  }

  // --- Signups ---
  // users.created_at is ISO TEXT, so a textual `>=` comparison is correct
  // when both sides are ISO 8601-normalized.
  const userCohort = buildCohortWhere(tag);
  const signupRows = db
    .prepare(
      `SELECT u.created_at AS ts
         FROM users u
        WHERE ${userCohort.clause}
          AND u.created_at >= ?`,
    )
    .all(...userCohort.params, sinceIso) as Array<{ ts: string }>;
  for (const row of signupRows) {
    const date = tzDateString(row.ts, timeZone);
    const bucket = byDate.get(date);
    if (bucket) bucket.signups++;
  }

  // --- Anonymous plays ---
  // visitor_attribution.first_game_at is also ISO TEXT.
  const visitorCohort = buildVisitorCohortWhere(tag);
  const anonRows = db
    .prepare(
      `SELECT v.first_game_at AS ts
         FROM visitor_attribution v
        WHERE ${visitorCohort.clause}
          AND v.first_game_at IS NOT NULL
          AND v.first_game_at >= ?
          AND v.claimed_user_id IS NULL`,
    )
    .all(...visitorCohort.params, sinceIso) as Array<{ ts: string }>;
  for (const row of anonRows) {
    const date = tzDateString(row.ts, timeZone);
    const bucket = byDate.get(date);
    if (bucket) bucket.anonymousPlays++;
  }

  // Sorted by date ascending because `days` came from enumerateDaysInRange
  // (which sorts before deduping).
  return Array.from(byDate.values());
}

// === Cross-tag comparison ===

/** One row in the cross-tag comparison leaderboard. */
export interface UtmTagComparisonRow {
  tagId: string;
  name: string;
  utmSource: string;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  status: UtmTagStatus;
  originKey: string | null;
  hasShortCode: boolean;
  /** Tag's lifetime click_count (no per-day decomposition exists). */
  clicksLifetime: number;
  /** Sessions in the window, 3-tuple cohort, bot-filtered. */
  sessions: number;
  /** Signups in the window, 5-tuple cohort. */
  signups: number;
  /** Unclaimed visitor_attribution rows with first_game_at in the window. */
  anonymousPlays: number;
  /** Point estimate signups/sessions; 0 when sessions=0. */
  conversionRate: number;
  /** Wilson 95% lower bound (used as the rank score). */
  ciLow: number;
  /** Wilson 95% upper bound. */
  ciHigh: number;
  /** True when sessions < {@link LOW_SAMPLE_SESSION_THRESHOLD}. */
  isLowSample: boolean;
  /** True when this row's CI is entirely above the global CI. */
  isSignificantlyAboveAverage: boolean;
  /** True when this row's CI is entirely below the global CI. */
  isSignificantlyBelowAverage: boolean;
  /** Last 7 daily signup counts, oldest → newest. Always 7 values. */
  sparkline: number[];
}

/**
 * Wilson interval shape on the wire. Same fields as
 * {@link WilsonInterval} except `point` is widened to allow `null` —
 * `wilsonInterval` returns NaN when n=0 and NaN does not survive
 * JSON.stringify, so the API boundary serializes it as `null` and the
 * client type matches.
 */
export interface WireWilsonInterval {
  /** Point estimate k/n; null when n=0 (caller renders "—"). */
  point: number | null;
  lo: number;
  hi: number;
  halfWidth: number;
}

/** Aggregate metrics across the comparison set used for context cards. */
export interface UtmTagComparisonSummary {
  /** Sum of click_count across all tags in the result (lifetime). */
  totalClicksLifetime: number;
  totalSessions: number;
  totalSignups: number;
  totalAnonymousPlays: number;
  /** Pooled conversion rate sum(signups)/sum(sessions). */
  globalConversionRate: number;
  /** Wilson 95% interval on the pooled rate (NaN-safe for the wire). */
  globalConversionCi: WireWilsonInterval;
  rangeDays: number;
  activeTagCount: number;
}

export interface UtmTagComparisonResponse {
  rows: UtmTagComparisonRow[];
  summary: UtmTagComparisonSummary;
}

/** Below this session count we mark the row as "low sample" — Wilson is
 *  defined but the interval is too wide to be actionable. Aligns with the
 *  threshold the planning sub-agents recommended. */
const LOW_SAMPLE_SESSION_THRESHOLD = 30;
const SPARKLINE_DAYS = 7;

/** Tuple key that distinguishes NULL from any non-empty string. UTM fields
 *  are normalized to NULL (not empty string) by the validator so a `|`-
 *  delimited key with `\x00` for NULL is unambiguous. */
function tupleKey3(
  s: string,
  m: string | null,
  c: string | null,
): string {
  return `${s}|${m ?? "\x00"}|${c ?? "\x00"}`;
}

function tupleKey5(
  s: string,
  m: string | null,
  c: string | null,
  content: string | null,
  term: string | null,
): string {
  return `${s}|${m ?? "\x00"}|${c ?? "\x00"}|${content ?? "\x00"}|${term ?? "\x00"}`;
}

/** Origin filter mirrors the listUtmTags surface. */
export type UtmTagComparisonOrigin = "admin" | "system" | "all";

export interface GetUtmTagComparisonOpts {
  rangeDays: number;
  origin?: UtmTagComparisonOrigin;
  /** Epoch ms; defaults to Date.now() (exposed for test determinism). */
  now?: number;
  /** IANA timezone for sparkline / range calc; defaults to admin TZ. */
  timeZone?: string;
}

/**
 * Build a ranked leaderboard of UTM tags with Wilson 95% CIs and the
 * volume + quality metrics needed by the admin dashboard's hero chart.
 *
 * Performance: instead of one query per tag (O(tags × rows)), this runs
 * a small fixed set of bulk-aggregation queries grouping by UTM tuple,
 * then joins back to the tag list in JS by tuple key. With dozens of
 * tags and tens of thousands of sessions in a 90-day window this is
 * comfortably <100ms on a warm SQLite cache.
 *
 * Cohort match: 3-tuple `(source, medium, campaign)` against sessions
 * (analytics_sessions has no entry_utm_content/term yet — v2 schema
 * follow-up); 5-tuple against users + visitor_attribution.
 *
 * Significance flag: a row is flagged "significantly above/below average"
 * when its Wilson 95% CI does not overlap the pooled global CI. This is
 * a conservative substitute for a frequentist test — easier to explain
 * to a non-statistician operator ("the bars don't touch").
 *
 * @param db - Database instance.
 * @param opts - Query options.
 * @returns Ranked rows + summary.
 */
export function getUtmTagComparison(
  db: DatabaseType,
  opts: GetUtmTagComparisonOpts,
): UtmTagComparisonResponse {
  const now = opts.now ?? Date.now();
  const sinceMs = now - opts.rangeDays * DAY_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  const timeZone = opts.timeZone ?? ADMIN_TIMEZONE;
  const origin = opts.origin ?? "admin";

  // 1. Tag list under the origin filter. Active-only: archived tags
  // belong to past campaigns and would clutter the leaderboard. The
  // existing listUtmTags surface still serves the archive view.
  const originClause =
    origin === "admin"
      ? " AND origin_key IS NULL"
      : origin === "system"
        ? " AND origin_key IS NOT NULL"
        : "";
  const tagRows = db
    .prepare(
      `SELECT * FROM utm_tags
        WHERE status = 'active'${originClause}
        ORDER BY created_at DESC, id DESC`,
    )
    .all() as UtmTagRow[];

  // 2. Bulk session aggregation by 3-tuple, bot-filtered, in window.
  const sessionAggRows = db
    .prepare(
      `SELECT entry_utm_source AS source,
              entry_utm_medium AS medium,
              entry_utm_campaign AS campaign,
              COUNT(*) AS sessions,
              SUM(signup_occurred) AS signup_in_session
         FROM analytics_sessions
        WHERE is_bot = 0
          AND started_at >= ?
          AND entry_utm_source IS NOT NULL
        GROUP BY entry_utm_source, entry_utm_medium, entry_utm_campaign`,
    )
    .all(sinceMs) as Array<{
    source: string;
    medium: string | null;
    campaign: string | null;
    sessions: number;
    signup_in_session: number | null;
  }>;
  const sessionsByKey = new Map<string, number>();
  for (const r of sessionAggRows) {
    sessionsByKey.set(tupleKey3(r.source, r.medium, r.campaign), r.sessions);
  }

  // 3. Bulk signup aggregation by 5-tuple. Counts users (one row each)
  // — the tag's funnel "signups" metric, not session-level signups.
  const signupAggRows = db
    .prepare(
      `SELECT utm_source AS source, utm_medium AS medium, utm_campaign AS campaign,
              utm_content AS content, utm_term AS term,
              COUNT(*) AS signups
         FROM users
        WHERE utm_source IS NOT NULL
          AND created_at >= ?
        GROUP BY utm_source, utm_medium, utm_campaign, utm_content, utm_term`,
    )
    .all(sinceIso) as Array<{
    source: string;
    medium: string | null;
    campaign: string | null;
    content: string | null;
    term: string | null;
    signups: number;
  }>;
  const signupsByKey = new Map<string, number>();
  for (const r of signupAggRows) {
    signupsByKey.set(
      tupleKey5(r.source, r.medium, r.campaign, r.content, r.term),
      r.signups,
    );
  }

  // 4. Bulk anonymous-plays aggregation by 5-tuple.
  const anonAggRows = db
    .prepare(
      `SELECT utm_source AS source, utm_medium AS medium, utm_campaign AS campaign,
              utm_content AS content, utm_term AS term,
              COUNT(*) AS anon
         FROM visitor_attribution
        WHERE utm_source IS NOT NULL
          AND first_game_at IS NOT NULL
          AND first_game_at >= ?
          AND claimed_user_id IS NULL
        GROUP BY utm_source, utm_medium, utm_campaign, utm_content, utm_term`,
    )
    .all(sinceIso) as Array<{
    source: string;
    medium: string | null;
    campaign: string | null;
    content: string | null;
    term: string | null;
    anon: number;
  }>;
  const anonByKey = new Map<string, number>();
  for (const r of anonAggRows) {
    anonByKey.set(
      tupleKey5(r.source, r.medium, r.campaign, r.content, r.term),
      r.anon,
    );
  }

  // 5. Sparkline data: last SPARKLINE_DAYS days of signups per 5-tuple,
  // re-bucketed in JS by admin TZ. Pull just the timestamps that fall
  // inside the sparkline window (which may be shorter than the headline
  // range — sparklines are always 7 days).
  const sparklineSinceMs = now - SPARKLINE_DAYS * DAY_MS;
  const sparklineSinceIso = new Date(sparklineSinceMs).toISOString();
  const sparklineRows = db
    .prepare(
      `SELECT utm_source AS source, utm_medium AS medium, utm_campaign AS campaign,
              utm_content AS content, utm_term AS term, created_at AS ts
         FROM users
        WHERE utm_source IS NOT NULL
          AND created_at >= ?`,
    )
    .all(sparklineSinceIso) as Array<{
    source: string;
    medium: string | null;
    campaign: string | null;
    content: string | null;
    term: string | null;
    ts: string;
  }>;
  const sparklineDays = enumerateDaysInRange(
    new Date(sparklineSinceMs),
    new Date(now),
    timeZone,
  );
  // Trim to the most recent SPARKLINE_DAYS so a DST-extended range
  // doesn't return 8 buckets when the spec requires 7.
  const sparklineKeys = sparklineDays.slice(-SPARKLINE_DAYS);
  const sparklineKeySet = new Set(sparklineKeys);
  const sparklineByKey = new Map<string, Map<string, number>>();
  for (const r of sparklineRows) {
    const tupKey = tupleKey5(r.source, r.medium, r.campaign, r.content, r.term);
    const date = tzDateString(r.ts, timeZone);
    // O(1) Set lookup vs O(7) array.includes — negligible at current
    // signup volume, but trivial to make robust against scale.
    if (!sparklineKeySet.has(date)) continue;
    let inner = sparklineByKey.get(tupKey);
    if (!inner) {
      inner = new Map();
      sparklineByKey.set(tupKey, inner);
    }
    inner.set(date, (inner.get(date) ?? 0) + 1);
  }

  // 6. Aggregate global totals across ALL session/signup rows that
  // matched the bulk queries. The global CR drives the significance
  // comparison; using "all UTM-attributed traffic in the window" as the
  // baseline is more honest than "only tags in the leaderboard" (which
  // would be a self-referential comparison).
  let totalSessionsGlobal = 0;
  for (const r of sessionAggRows) totalSessionsGlobal += r.sessions;
  let totalSignupsGlobal = 0;
  for (const r of signupAggRows) totalSignupsGlobal += r.signups;
  let totalAnonGlobal = 0;
  for (const r of anonAggRows) totalAnonGlobal += r.anon;
  const globalCi = wilsonInterval(totalSignupsGlobal, totalSessionsGlobal);
  // wilsonInterval returns NaN as the point estimate when n=0 (correct math
  // semantics — 0/0 is undefined). NaN does not survive JSON serialization
  // (JSON.stringify coerces it to null), so we explicitly null it here so
  // the client always sees a valid number-or-null without a round-trip
  // surprise. Bounds [lo, hi] = [0, 1] in the n=0 sentinel are both
  // already valid numbers and pass through unchanged.
  const globalCiSerializable: { point: number | null; lo: number; hi: number; halfWidth: number } = {
    point: Number.isFinite(globalCi.point) ? globalCi.point : null,
    lo: globalCi.lo,
    hi: globalCi.hi,
    halfWidth: globalCi.halfWidth,
  };

  // 7. Build per-tag comparison rows.
  const rows: UtmTagComparisonRow[] = tagRows.map((tag) => {
    const sessKey = tupleKey3(tag.utm_source, tag.utm_medium, tag.utm_campaign);
    const userKey = tupleKey5(
      tag.utm_source,
      tag.utm_medium,
      tag.utm_campaign,
      tag.utm_content,
      tag.utm_term,
    );
    const sessions = sessionsByKey.get(sessKey) ?? 0;
    const signups = signupsByKey.get(userKey) ?? 0;
    const anonymousPlays = anonByKey.get(userKey) ?? 0;
    const ci = wilsonInterval(signups, sessions);
    const sparkBuckets = sparklineByKey.get(userKey);
    const sparkline = sparklineKeys.map((d) => sparkBuckets?.get(d) ?? 0);
    // Significance: only meaningful when both intervals are real (not the
    // n=0 [0,1] sentinel). Suppress the flag for low-sample rows so a
    // narrow Wilson CI on a 1/1=100% tag doesn't trip it falsely.
    const isLowSample = sessions < LOW_SAMPLE_SESSION_THRESHOLD;
    let isSignificantlyAboveAverage = false;
    let isSignificantlyBelowAverage = false;
    if (
      !isLowSample &&
      totalSessionsGlobal >= LOW_SAMPLE_SESSION_THRESHOLD
    ) {
      const cmp = wilsonCompare(ci, globalCi);
      isSignificantlyAboveAverage = cmp === "above";
      isSignificantlyBelowAverage = cmp === "below";
    }
    return {
      tagId: tag.id,
      name: tag.name,
      utmSource: tag.utm_source,
      utmMedium: tag.utm_medium,
      utmCampaign: tag.utm_campaign,
      utmContent: tag.utm_content,
      utmTerm: tag.utm_term,
      status: tag.status as UtmTagStatus,
      originKey: tag.origin_key,
      hasShortCode: tag.short_code !== null,
      clicksLifetime: tag.click_count,
      sessions,
      signups,
      anonymousPlays,
      conversionRate: sessions > 0 ? signups / sessions : 0,
      ciLow: ci.lo,
      ciHigh: ci.hi,
      isLowSample,
      isSignificantlyAboveAverage,
      isSignificantlyBelowAverage,
      sparkline,
    };
  });

  // 8. Rank by Wilson lower bound desc; ties broken by sessions desc
  // (recent + reliable wins over a distant high-confidence tail).
  rows.sort((a, b) => {
    if (b.ciLow !== a.ciLow) return b.ciLow - a.ciLow;
    if (b.sessions !== a.sessions) return b.sessions - a.sessions;
    return a.name.localeCompare(b.name);
  });

  // 9. Sum click_count across the rows we're presenting (lifetime KPI;
  // bounded to the origin filter so the system-tag toggle gives a
  // consistent denominator for the headline tile).
  const totalClicksLifetime = rows.reduce(
    (s, r) => s + r.clicksLifetime,
    0,
  );

  return {
    rows,
    summary: {
      totalClicksLifetime,
      totalSessions: totalSessionsGlobal,
      totalSignups: totalSignupsGlobal,
      totalAnonymousPlays: totalAnonGlobal,
      globalConversionRate:
        totalSessionsGlobal > 0 ? totalSignupsGlobal / totalSessionsGlobal : 0,
      globalConversionCi: globalCiSerializable,
      rangeDays: opts.rangeDays,
      activeTagCount: rows.length,
    },
  };
}
