/**
 * Site settings service — key-value store for admin-configurable options.
 *
 * Supports promo banner configuration, game mode toggles, avatar
 * enable/disable, and legal documents (privacy policy, terms of
 * service). All values are stored
 * as JSON strings in the site_settings table.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { PromoBanner, GameMode } from "@price-game/shared";
import { VALID_GAME_MODES, DEFAULT_DAILY_SCHEDULE, AVATARS } from "@price-game/shared";

const DEFAULT_BANNER: PromoBanner = {
  enabled: true,
  text: "Score 20,000+ points for a chance to win a $20 Amazon Gift Card!",
  linkText: "Learn More",
  linkUrl: "/settings",
  audienceMode: "logged_in",
  showLink: true,
  showGiveawayModal: true,
  giveawayMinPoints: 20000,
  // Streak-based qualification is opt-in per banner; defaults preserve legacy
  // points-only behavior so existing deployments render exactly as before.
  giveawayMinStreak: 0,
  giveawayQualifyMode: "points_only",
  showTracker: true,
  qualifiedMessage: "You're entered in the {month} drawing! Increase your odds — refer a friend for bonus entries.",
};

interface SettingsRow {
  key: string;
  value: string;
  updated_at: string;
}

/**
 * Get a site setting by key.
 *
 * @param db - Database instance.
 * @param key - The setting key.
 * @returns The parsed JSON value, or null if not found.
 */
export function getSetting<T>(db: DatabaseType, key: string): T | null {
  const row = db.prepare("SELECT value FROM site_settings WHERE key = ?").get(key) as SettingsRow | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/**
 * Set a site setting by key.
 *
 * @param db - Database instance.
 * @param key - The setting key.
 * @param value - The value to store (will be JSON-serialized).
 */
export function setSetting<T>(db: DatabaseType, key: string, value: T): void {
  const now = new Date().toISOString();
  const json = JSON.stringify(value);
  db.prepare(
    `INSERT INTO site_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, json, now);
}

/**
 * Get the promo banner configuration. Merges stored values with defaults
 * so that newly added fields are populated for existing database records.
 *
 * @param db - Database instance.
 * @returns The banner settings.
 */
export function getPromoBanner(db: DatabaseType): PromoBanner {
  const stored = getSetting<Partial<PromoBanner>>(db, "promo_banner");
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return DEFAULT_BANNER;
  return { ...DEFAULT_BANNER, ...stored };
}

/**
 * Update the promo banner configuration.
 *
 * @param db - Database instance.
 * @param banner - Partial banner updates.
 * @returns The updated banner settings.
 */
export function updatePromoBanner(db: DatabaseType, banner: Partial<PromoBanner>): PromoBanner {
  const current = getPromoBanner(db);
  const updated: PromoBanner = {
    enabled: banner.enabled !== undefined ? banner.enabled : current.enabled,
    text: banner.text !== undefined ? banner.text : current.text,
    linkText: banner.linkText !== undefined ? banner.linkText : current.linkText,
    linkUrl: banner.linkUrl !== undefined ? banner.linkUrl : current.linkUrl,
    audienceMode: banner.audienceMode !== undefined ? banner.audienceMode : current.audienceMode,
    showLink: banner.showLink !== undefined ? banner.showLink : current.showLink,
    showGiveawayModal: banner.showGiveawayModal !== undefined ? banner.showGiveawayModal : current.showGiveawayModal,
    giveawayMinPoints: banner.giveawayMinPoints !== undefined ? banner.giveawayMinPoints : current.giveawayMinPoints,
    giveawayMinStreak: banner.giveawayMinStreak !== undefined ? banner.giveawayMinStreak : current.giveawayMinStreak,
    giveawayQualifyMode: banner.giveawayQualifyMode !== undefined ? banner.giveawayQualifyMode : current.giveawayQualifyMode,
    showTracker: banner.showTracker !== undefined ? banner.showTracker : current.showTracker,
    qualifiedMessage: banner.qualifiedMessage !== undefined ? banner.qualifiedMessage : current.qualifiedMessage,
  };
  setSetting(db, "promo_banner", updated);
  return updated;
}

// ===== Game Mode Enable/Disable =====

/**
 * Get the list of disabled game modes from site settings.
 *
 * @param db - Database instance.
 * @returns Array of disabled game mode identifiers (empty if none disabled).
 */
export function getDisabledGameModes(db: DatabaseType): string[] {
  const stored = getSetting<string[]>(db, "disabled_game_modes");
  if (!Array.isArray(stored)) return [];
  return stored.filter((m) => typeof m === "string" && VALID_GAME_MODES.has(m));
}

/**
 * Set the list of disabled game modes in site settings.
 *
 * @param db - Database instance.
 * @param modes - Array of game mode identifiers to disable.
 * @returns The validated array of disabled modes that was saved.
 * @throws Error if any mode is not in VALID_GAME_MODES.
 */
export function setDisabledGameModes(db: DatabaseType, modes: string[]): string[] {
  for (const m of modes) {
    if (!VALID_GAME_MODES.has(m)) {
      throw new Error(`Invalid game mode: ${m}`);
    }
  }
  const unique = [...new Set(modes)];
  setSetting(db, "disabled_game_modes", unique);
  return unique;
}

/**
 * Check whether a game mode is currently enabled.
 *
 * @param db - Database instance.
 * @param mode - The game mode identifier to check.
 * @returns true if the mode is enabled (i.e. not in the disabled list).
 */
export function isGameModeEnabled(db: DatabaseType, mode: string): boolean {
  const disabled = getDisabledGameModes(db);
  return !disabled.includes(mode);
}

// ===== Avatar Enable/Disable =====

const VALID_AVATARS = new Set<string>(AVATARS);

/**
 * Get the list of disabled avatars from site settings.
 *
 * @param db - Database instance.
 * @returns Array of disabled avatar identifiers (empty if none disabled).
 */
export function getDisabledAvatars(db: DatabaseType): string[] {
  const stored = getSetting<string[]>(db, "disabled_avatars");
  if (!Array.isArray(stored)) return [];
  return stored.filter((a) => typeof a === "string" && VALID_AVATARS.has(a));
}

/**
 * Set the list of disabled avatars in site settings.
 *
 * @param db - Database instance.
 * @param avatars - Array of avatar identifiers to disable.
 * @returns The validated array of disabled avatars that was saved.
 * @throws Error if any avatar is not in AVATARS.
 */
export function setDisabledAvatars(db: DatabaseType, avatars: string[]): string[] {
  for (const a of avatars) {
    if (!VALID_AVATARS.has(a)) {
      throw new Error(`Invalid avatar: ${a}`);
    }
  }
  const unique = [...new Set(avatars)];
  setSetting(db, "disabled_avatars", unique);
  return unique;
}

/**
 * Check whether an avatar is currently enabled.
 *
 * @param db - Database instance.
 * @param avatar - The avatar identifier to check.
 * @returns true if the avatar is enabled (i.e. not in the disabled list).
 */
export function isAvatarEnabled(db: DatabaseType, avatar: string): boolean {
  const disabled = getDisabledAvatars(db);
  return !disabled.includes(avatar);
}

// ===== Legal Documents =====

/** Valid legal document keys. */
const VALID_LEGAL_KEYS = new Set(["privacy_policy", "terms_of_service"]);

/**
 * Get a legal document (privacy policy or terms of service) as markdown.
 *
 * @param db - Database instance.
 * @param key - The document key ("privacy_policy" or "terms_of_service").
 * @returns The markdown content, or an empty string if not yet configured.
 * @throws Error if the key is not a valid legal document key.
 */
export function getLegalDocument(db: DatabaseType, key: string): string {
  if (!VALID_LEGAL_KEYS.has(key)) {
    throw new Error(`Invalid legal document key: ${key}`);
  }
  const stored = getSetting<string>(db, `legal_${key}`);
  return typeof stored === "string" ? stored : "";
}

/**
 * Set a legal document's markdown content.
 *
 * @param db - Database instance.
 * @param key - The document key ("privacy_policy" or "terms_of_service").
 * @param content - The markdown content to store.
 * @throws Error if the key is not a valid legal document key.
 */
export function setLegalDocument(db: DatabaseType, key: string, content: string): void {
  if (!VALID_LEGAL_KEYS.has(key)) {
    throw new Error(`Invalid legal document key: ${key}`);
  }
  setSetting(db, `legal_${key}`, content);
}

// ===== Site Content Pages (About, FAQ, Contact) =====

/** Valid editable content document keys. Exported so routers can validate
 *  route params against the same allowlist used by the service layer. */
export const VALID_CONTENT_KEYS: ReadonlySet<string> = new Set(["about", "faq", "contact"]);

/** Maximum stored length for a content document's JSON payload. Protects
 *  against oversized admin input. 200 KB easily covers a hefty About or
 *  FAQ page. */
export const CONTENT_MAX_BYTES = 200_000;

/** Default content for each page — used when the admin has not yet
 *  configured one. Kept short and non-empty so the public page isn't blank
 *  on a brand-new deploy. */
const DEFAULT_CONTENT: Record<string, SiteContent> = {
  about: {
    key: "about",
    title: "About Price Games",
    body:
      "Price Games is a free online game where you guess the prices of real products.\n\n" +
      "We're a small team building a playful way to test your pricing intuition — " +
      "solo, against friends in live multiplayer rooms, or in the once-a-day daily challenge.",
  },
  faq: {
    key: "faq",
    title: "Frequently Asked Questions",
    items: [
      { question: "Is Price Games free?", answer: "Yes — every game mode is free to play, with no signup required." },
      { question: "Do I need an account?", answer: "No. An account unlocks leaderboards, streaks, and rewards, but anonymous play is supported for every mode." },
      { question: "Where do product prices come from?", answer: "Prices are sourced from real Amazon product listings and may vary from what you see on Amazon today." },
      { question: "How is scoring calculated?", answer: "Each mode uses its own scoring formula tuned to the mechanic — see the Game Modes page for per-mode details." },
    ],
  },
  contact: {
    key: "contact",
    title: "Contact Us",
    body: "Have a question, bug report, or partnership idea? We'd love to hear from you.",
    email: "",
    social: [],
  },
};

/** Shape of the About page document stored in site_settings. */
export interface AboutContent {
  key: "about";
  title: string;
  /** Markdown body. */
  body: string;
}

/** Shape of the FAQ document stored in site_settings. */
export interface FaqContent {
  key: "faq";
  title: string;
  items: Array<{ question: string; answer: string }>;
}

/** Shape of the Contact page document stored in site_settings. */
export interface ContactContent {
  key: "contact";
  title: string;
  /** Markdown body. */
  body: string;
  /** Public contact email (optional; empty string to hide). */
  email?: string;
  /** Array of named social links, e.g. `{ label: "Twitter", url: "..." }`. */
  social?: Array<{ label: string; url: string }>;
}

/** Tagged union of all editable content document shapes. */
export type SiteContent = AboutContent | FaqContent | ContactContent;

/**
 * Get a site content document (about/faq/contact). Falls back to a
 * non-empty default so public pages never render as blank on a fresh
 * deploy.
 *
 * @param db - Database instance.
 * @param key - One of "about", "faq", "contact".
 * @returns The content document (always non-null for valid keys).
 * @throws Error if the key is not a recognized content key.
 */
export function getSiteContent(db: DatabaseType, key: string): SiteContent {
  if (!VALID_CONTENT_KEYS.has(key)) {
    throw new Error(`Invalid content key: ${key}`);
  }
  const stored = getSetting<Record<string, unknown>>(db, `content_${key}`);
  if (!stored || typeof stored !== "object") {
    return DEFAULT_CONTENT[key];
  }
  // Shallow-merge stored values onto defaults so fields added after the row
  // was written continue to resolve sensibly. Re-stamp the discriminator
  // from the defaults to keep the tagged-union type sound.
  if (key === "about") {
    return { ...(DEFAULT_CONTENT.about as AboutContent), ...stored, key: "about" };
  }
  if (key === "faq") {
    return { ...(DEFAULT_CONTENT.faq as FaqContent), ...stored, key: "faq" };
  }
  return { ...(DEFAULT_CONTENT.contact as ContactContent), ...stored, key: "contact" };
}

/**
 * Persist a site content document. Validates the payload shape against
 * the target key — callers pass raw untrusted JSON so bad input must not
 * corrupt the stored value.
 *
 * @throws Error if the key is invalid or the payload fails validation.
 */
export function setSiteContent(db: DatabaseType, key: string, value: unknown): SiteContent {
  if (!VALID_CONTENT_KEYS.has(key)) {
    throw new Error(`Invalid content key: ${key}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Content payload must be an object");
  }
  const raw = value as Record<string, unknown>;
  const size = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (size > CONTENT_MAX_BYTES) {
    throw new Error(`Content exceeds maximum size of ${CONTENT_MAX_BYTES} bytes`);
  }

  let normalized: SiteContent;
  if (key === "about") {
    normalized = {
      key: "about",
      title: typeof raw.title === "string" ? raw.title.slice(0, 200) : DEFAULT_CONTENT.about.title,
      body: typeof raw.body === "string" ? raw.body : "",
    };
  } else if (key === "faq") {
    const items = Array.isArray(raw.items) ? raw.items : [];
    const safeItems = items
      .filter((it): it is { question: unknown; answer: unknown } => typeof it === "object" && it !== null)
      .map((it) => ({
        question: typeof it.question === "string" ? it.question.slice(0, 300) : "",
        answer: typeof it.answer === "string" ? it.answer : "",
      }))
      .filter((it) => it.question.length > 0 && it.answer.length > 0);
    normalized = {
      key: "faq",
      title: typeof raw.title === "string" ? raw.title.slice(0, 200) : DEFAULT_CONTENT.faq.title,
      items: safeItems,
    };
  } else {
    const social = Array.isArray(raw.social) ? raw.social : [];
    const safeSocial = social
      .filter((it): it is { label: unknown; url: unknown } => typeof it === "object" && it !== null)
      .map((it) => ({
        label: typeof it.label === "string" ? it.label.slice(0, 40) : "",
        url: typeof it.url === "string" ? it.url.slice(0, 500) : "",
      }))
      .filter((it) => it.label.length > 0 && /^https?:\/\//.test(it.url));
    // Validate the email field: must look like an email or be empty. A
    // malformed value would be interpolated into `mailto:${email}` on the
    // public page, so anything that doesn't match a standard email shape is
    // dropped rather than stored.
    const rawEmail = typeof raw.email === "string" ? raw.email.trim().slice(0, 200) : "";
    const safeEmail = rawEmail === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : "";
    normalized = {
      key: "contact",
      title: typeof raw.title === "string" ? raw.title.slice(0, 200) : DEFAULT_CONTENT.contact.title,
      body: typeof raw.body === "string" ? raw.body : "",
      email: safeEmail,
      social: safeSocial,
    };
  }
  setSetting(db, `content_${key}`, normalized);
  return normalized;
}

// ===== Daily Challenge Mode =====

/**
 * Check whether the daily challenge mode is currently enabled. Defaults to
 * FALSE when the setting is unset, missing, or stored as anything other than
 * the strict boolean `true`. Default-off is intentional: the feature ships
 * disabled and an admin must explicitly enable it via the admin panel.
 *
 * @param db - Database instance.
 * @returns true iff daily challenge is enabled.
 */
export function isDailyEnabled(db: DatabaseType): boolean {
  const stored = getSetting<boolean>(db, "daily_enabled");
  return stored === true;
}

/**
 * Enable or disable the daily challenge mode. Coerces non-boolean truthy
 * values to true and non-boolean falsy values to false so the on-disk
 * representation is always a strict boolean.
 *
 * @param db - Database instance.
 * @param enabled - Whether to enable daily challenge.
 */
export function setDailyEnabled(db: DatabaseType, enabled: boolean): void {
  setSetting(db, "daily_enabled", Boolean(enabled));
}

/**
 * Get the current 7-slot weekly schedule (one mode per UTC day-of-week,
 * indexed 0=Sunday). Returns DEFAULT_DAILY_SCHEDULE when the setting is
 * unset, malformed, has the wrong length, or contains an unknown game
 * mode — so callers can always assume a valid schedule.
 *
 * @param db - Database instance.
 * @returns A length-7 readonly array of game modes.
 */
export function getDailySchedule(db: DatabaseType): readonly GameMode[] {
  const stored = getSetting<unknown>(db, "daily_schedule");
  if (!Array.isArray(stored)) return DEFAULT_DAILY_SCHEDULE;
  if (stored.length !== 7) return DEFAULT_DAILY_SCHEDULE;
  for (const m of stored) {
    if (typeof m !== "string" || !VALID_GAME_MODES.has(m)) {
      return DEFAULT_DAILY_SCHEDULE;
    }
  }
  return stored as GameMode[];
}

/**
 * Replace the weekly schedule. Validates that the input is an array of
 * exactly 7 known game modes; throws on any violation without mutating
 * the previously-stored value.
 *
 * @param db - Database instance.
 * @param schedule - The new schedule (length 7, indexed 0=Sunday).
 * @returns The persisted schedule.
 * @throws Error if the input is not a length-7 array of known game modes.
 */
export function setDailySchedule(db: DatabaseType, schedule: GameMode[]): readonly GameMode[] {
  if (!Array.isArray(schedule)) {
    throw new Error("daily schedule must be an array");
  }
  if (schedule.length !== 7) {
    throw new Error("daily schedule must have exactly 7 entries (one per UTC weekday)");
  }
  for (const m of schedule) {
    if (typeof m !== "string" || !VALID_GAME_MODES.has(m)) {
      throw new Error(`Invalid game mode in daily schedule: ${String(m)}`);
    }
  }
  setSetting(db, "daily_schedule", schedule);
  return schedule;
}

// ===== Public SEO Page Visibility =====

/** Canonical identifiers for the public SEO pages whose visibility is
 *  controlled from the admin panel. Written with underscores so they are
 *  JSON-friendly storage keys; the URL path for `game_modes` is
 *  `/game-modes`. */
export type PageKey =
  | "about"
  | "faq"
  | "contact"
  | "game_modes"
  | "privacy"
  | "terms";

/** Ordered list of page keys — preserves admin UI rendering order. */
export const PAGE_KEYS: readonly PageKey[] = [
  "about",
  "faq",
  "contact",
  "game_modes",
  "privacy",
  "terms",
];

const PAGE_KEY_SET: ReadonlySet<string> = new Set(PAGE_KEYS);

/** Map from each `PageKey` to a boolean enabled flag. */
export type EnabledPages = Record<PageKey, boolean>;

/** Default visibility for every SEO page: disabled. A fresh deploy must
 *  opt each page in via the admin panel; this prevents broken/empty
 *  pages from being reachable before an admin populates them. */
const DEFAULT_ENABLED_PAGES: EnabledPages = {
  about: false,
  faq: false,
  contact: false,
  game_modes: false,
  privacy: false,
  terms: false,
};

/**
 * Get the enabled/disabled flags for the public SEO pages. Missing or
 * malformed storage falls back to "all disabled" so a corrupted row can
 * never accidentally expose an unpopulated page.
 *
 * @param db - Database instance.
 * @returns Map of page key → boolean. Always contains every `PageKey`.
 */
export function getEnabledPages(db: DatabaseType): EnabledPages {
  const stored = getSetting<Record<string, unknown>>(db, "enabled_pages");
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { ...DEFAULT_ENABLED_PAGES };
  }
  const result: EnabledPages = { ...DEFAULT_ENABLED_PAGES };
  for (const key of PAGE_KEYS) {
    // Strict boolean: anything other than `true` is treated as disabled so
    // admins must explicitly opt a page in.
    if (stored[key] === true) result[key] = true;
  }
  return result;
}

/**
 * Check whether a single public SEO page is enabled. Unknown keys
 * return false so route handlers can safely gate on this without
 * threading "invalid key" handling separately.
 *
 * @param db - Database instance.
 * @param key - The page key to check.
 */
export function isPageEnabled(db: DatabaseType, key: string): boolean {
  if (!PAGE_KEY_SET.has(key)) return false;
  const pages = getEnabledPages(db);
  return pages[key as PageKey] === true;
}

/**
 * Persist the enabled/disabled flags for the public SEO pages. Ignores
 * unknown keys and coerces all values to strict booleans so the on-disk
 * representation always has the full shape.
 *
 * @param db - Database instance.
 * @param pages - A partial map of page keys to enable/disable. Any key
 *   not present in the input is treated as disabled.
 * @returns The full, persisted map.
 * @throws Error if `pages` is not a plain object.
 */
export function setEnabledPages(db: DatabaseType, pages: unknown): EnabledPages {
  if (!pages || typeof pages !== "object" || Array.isArray(pages)) {
    throw new Error("enabled pages payload must be an object");
  }
  const input = pages as Record<string, unknown>;
  const next: EnabledPages = { ...DEFAULT_ENABLED_PAGES };
  for (const key of PAGE_KEYS) {
    next[key] = input[key] === true;
  }
  setSetting(db, "enabled_pages", next);
  return next;
}
