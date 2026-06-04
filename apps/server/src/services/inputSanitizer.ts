/**
 * Input sanitization and profanity filtering for user-provided text.
 *
 * All user-facing text (display names, leaderboard names, passwords)
 * should pass through these functions before storage.
 */

import { UserFacingError } from "./errors";

// --- Profanity word list ---
// Covers common English profanity, slurs, and leetspeak variants.
// Words are stored lowercase; matching is case-insensitive and boundary-aware.
const PROFANITY_WORDS: string[] = [
  // Common profanity
  "fuck", "fucker", "fucking", "fucked", "fucks", "fuckface", "fuckhead",
  "motherfucker", "motherfucking", "mfer",
  "shit", "shitty", "bullshit", "shithead", "shitface",
  "ass", "asshole", "asshat", "asswipe", "dumbass", "jackass", "badass",
  "damn", "damnit", "goddamn", "goddamnit",
  "bitch", "bitches", "bitchy", "bitchass",
  "bastard", "bastards",
  "dick", "dickhead", "dickface", "dicks",
  "cock", "cocksucker", "cocks",
  "cunt", "cunts",
  "piss", "pissed", "pissoff",
  "whore", "whores",
  "slut", "sluts", "slutty",
  "tits", "titty", "titties",
  "boob", "boobs", "booby",
  "wanker", "wankers", "wank",
  "twat", "twats",
  "prick", "pricks",
  "bollocks",
  "arse", "arsehole",
  "bugger",
  "tosser",
  "bellend",
  "knob", "knobhead",
  "douche", "douchebag",
  "jerkoff",

  // Slurs and hate speech
  "nigger", "nigga", "niggas", "nigg3r", "n1gger", "n1gga",
  "faggot", "faggots", "fag", "fags",
  "dyke", "dykes",
  "tranny", "trannies",
  "retard", "retarded", "retards",
  "spic", "spick", "spics",
  "chink", "chinks",
  "gook", "gooks",
  "kike", "kikes",
  "wetback", "wetbacks",
  "beaner", "beaners",
  "coon", "coons",
  "darkie", "darkies",
  "raghead", "ragheads",
  "towelhead",
  "cracker", "crackers",
  "honky", "honkey",
  "gringo",
  "jap", "japs",
  "paki", "pakis",
  "zipperhead",

  // Sexual
  "porn", "porno", "pornstar",
  "dildo", "dildos",
  "blowjob", "blowjobs",
  "handjob", "handjobs",
  "cumshot",
  "cum", "cums", "cumming",
  "jizz",
  "orgasm",
  "masturbate", "masturbating",
  "ejaculate",
  "erection",
  "penis", "penises",
  "vagina", "vaginas",
  "clitoris",
  "anus",
  "anal",
  "felch",
  "rimjob",
  "queef",

  // Drug references (context-dependent, but block in names)
  "meth",
  "heroin",
  "cocaine",

  // Misc offensive
  "nazi", "nazis",
  "hitler",
  "kkk",
  "jihad",
  "rape", "raping", "rapist",
  "molest", "molester", "molesting",
  "pedo", "pedophile", "paedo",
  "incest",
  "bestiality",
  "necrophilia",
  "genocide",
  "suicide",
  "kill yourself", "kys",
];

// Words that should be caught even when embedded in other text (e.g. "FuckYou").
// These are severe enough that substring matching won't cause meaningful false positives.
const SUBSTRING_WORDS: string[] = [
  "fuck", "shit", "cunt", "cock", "dick", "twat", "piss",
  "nigger", "nigga", "n1gger", "n1gga", "nigg3r",
  "faggot", "fag",
  "retard",
  "whore", "slut",
  "kike", "spic", "chink", "gook", "coon",
  "rape", "rapist",
  "pedo", "paedo", "pedophile",
  "nazi",
];

// Build regex for word-boundary matching (milder words — avoids "class" → "ass")
const profanityRegex = new RegExp(
  "\\b(" + PROFANITY_WORDS.map(escapeRegex).join("|") + ")\\b",
  "i"
);

// Build regex for substring matching (severe words — catches "FuckYou", "shithead" etc.)
const substringRegex = new RegExp(
  "(" + SUBSTRING_WORDS.map(escapeRegex).join("|") + ")",
  "i"
);

// Also match leetspeak substitutions: common letter→number swaps
function normalizeLeetspeak(text: string): string {
  return text
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/@/g, "a")
    .replace(/\$/g, "s")
    .replace(/\+/g, "t");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if text contains profanity.
 * Returns true if profanity is detected.
 */
export function containsProfanity(text: string): boolean {
  if (!text) return false;

  const lower = text.toLowerCase();

  // Substring check for severe words (catches "FuckYou", "shithead", etc.)
  if (substringRegex.test(lower)) return true;

  // Word-boundary check for all words
  if (profanityRegex.test(text)) return true;

  // Check with spaces/separators removed (catches "f u c k", "f-u-c-k", etc.)
  const collapsed = lower.replace(/[\s_\-.*#@!]/g, "");
  if (substringRegex.test(collapsed)) return true;
  if (profanityRegex.test(collapsed)) return true;

  // Check leetspeak-normalized version
  const leet = normalizeLeetspeak(lower);
  if (substringRegex.test(leet)) return true;
  if (profanityRegex.test(leet)) return true;

  const leetCollapsed = normalizeLeetspeak(collapsed);
  if (substringRegex.test(leetCollapsed)) return true;
  if (profanityRegex.test(leetCollapsed)) return true;

  return false;
}

/**
 * Sanitize a display name for multiplayer or leaderboard use.
 *
 * - Strips HTML tags
 * - Trims whitespace
 * - Collapses internal whitespace runs
 * - Enforces max length
 * - Rejects empty strings (throws)
 * - Rejects profanity (throws)
 */
export function sanitizeName(name: string, maxLength: number = 20): string {
  if (!name || typeof name !== "string") {
    throw new UserFacingError("Name is required");
  }

  // Strip HTML tags
  let clean = name.replace(/<[^>]*>/g, "");

  // Strip control characters (except normal whitespace)
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Trim and collapse internal whitespace
  clean = clean.trim().replace(/\s+/g, " ");

  // Enforce max length
  clean = clean.slice(0, maxLength);

  // Must have content after sanitization
  if (clean.length === 0) {
    throw new UserFacingError("Name is required");
  }

  // Profanity check
  if (containsProfanity(clean)) {
    throw new UserFacingError("That name is not allowed");
  }

  return clean;
}

/**
 * Sanitize a room password.
 *
 * - Strips HTML tags and control characters
 * - Trims whitespace
 * - Enforces max length (32 chars)
 * - Returns null for empty input (no password)
 */
/** Reserved usernames that cannot be claimed by user accounts. */
const RESERVED_USERNAMES = new Set([
  "admin", "system", "moderator", "support",
  "null", "undefined", "deleted", "price-games",
]);

/**
 * Validate and sanitize a username for user account registration.
 *
 * Strips HTML tags, control characters, and trims whitespace (like sanitizeName).
 * Enforces 3-20 character length, alphanumeric plus underscore only.
 * Rejects profanity and reserved words. Returns cleaned username preserving
 * original casing.
 *
 * @param username - Raw username string to validate.
 * @returns Cleaned username with original casing preserved.
 * @throws UserFacingError if validation fails.
 */
export function validateUsername(username: string): string {
  if (!username || typeof username !== "string") {
    throw new UserFacingError("Username is required");
  }

  // Strip HTML tags
  let clean = username.replace(/<[^>]*>/g, "");

  // Strip control characters (except normal whitespace)
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Trim whitespace
  clean = clean.trim();

  // Enforce length: 3-20 characters
  if (clean.length < 3) {
    throw new UserFacingError("Username must be at least 3 characters");
  }
  if (clean.length > 20) {
    throw new UserFacingError("Username must be at most 20 characters");
  }

  // Enforce allowed characters: alphanumeric + underscore only
  if (!/^[a-zA-Z0-9_]+$/.test(clean)) {
    throw new UserFacingError("Username may only contain letters, numbers, and underscores");
  }

  // Profanity check
  if (containsProfanity(clean)) {
    throw new UserFacingError("That username is not allowed");
  }

  // Reserved words check (case-insensitive)
  if (RESERVED_USERNAMES.has(clean.toLowerCase())) {
    throw new UserFacingError("That username is reserved");
  }

  return clean;
}

export function sanitizePassword(password: string | undefined | null): string | null {
  if (!password || typeof password !== "string") return null;

  let clean = password.replace(/<[^>]*>/g, "");
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  clean = clean.trim();

  if (clean.length === 0) return null;
  if (clean.length > 32) clean = clean.slice(0, 32);

  return clean;
}
