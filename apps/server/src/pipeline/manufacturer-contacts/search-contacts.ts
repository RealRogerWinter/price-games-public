/**
 * Search query generation and result parsing for manufacturer contact lookup.
 *
 * This module provides the query templates and validation logic used by the
 * pipeline. The actual web searching is performed by Claude Code sub-agents
 * using WebSearch/WebFetch tools — this module prepares what to search and
 * validates what comes back.
 *
 * @module search-contacts
 */

import type { ContactSearchResult, ContactInput } from "./types";

/**
 * Sanitize a manufacturer name for safe embedding in prompts and queries.
 *
 * Enforces a maximum length of 100 characters, strips non-printable characters,
 * and escapes double quotes to prevent prompt injection.
 *
 * @param name - Raw manufacturer name.
 * @returns Sanitized manufacturer name.
 */
export function sanitizeManufacturerName(name: string): string {
  return name
    .replace(/[^\x20-\x7E]/g, "") // strip non-printable / non-ASCII
    .replace(/"/g, '\\"')          // escape double quotes
    .trim()
    .slice(0, 100);
}

/**
 * Generate a set of web search queries for finding a manufacturer's contact info.
 *
 * Returns queries targeting media/PR contacts, promotions/partnerships,
 * and general contact information.
 *
 * @param manufacturer - The manufacturer/brand name.
 * @returns Array of search query strings.
 */
export function generateSearchQueries(manufacturer: string): string[] {
  const safe = sanitizeManufacturerName(manufacturer);
  return [
    `${safe} media relations contact email`,
    `${safe} press PR contact email address`,
    `${safe} promotions partnerships contact`,
    `${safe} brand sponsorship collaboration email`,
    `${safe} official contact page`,
    `"${safe}" site:linkedin.com PR media relations`,
  ];
}

/**
 * Validate whether a string is a plausible email address.
 *
 * Uses a simple regex check — not RFC 5322 compliant but sufficient for
 * filtering obviously invalid strings.
 *
 * @param email - String to validate.
 * @returns true if the string looks like an email address.
 */
export function isValidEmail(email: string): boolean {
  if (!email || email.length === 0) return false;
  // Simple check: local@domain.tld, no spaces, at least one dot after @
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Ensure a URL has a protocol prefix (https:// by default).
 *
 * This is a simple prefix helper — it does not validate full URL structure.
 * Use it only for normalizing user-supplied URLs that may omit the scheme.
 *
 * @param url - URL string, possibly without protocol.
 * @returns URL with https:// prefix, or empty string for blank input.
 */
export function ensureProtocol(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

// Backward-compatible alias
export { ensureProtocol as normalizeUrl };

/**
 * Validate and clean a ContactSearchResult from a web search.
 *
 * - Filters out contacts with invalid emails (unless they have phone or page URL)
 * - Removes contacts with no actionable contact info at all
 * - Normalizes the website URL
 *
 * @param raw - The raw search result to validate.
 * @returns Cleaned ContactSearchResult with only valid contacts.
 */
export function parseContactSearchResult(
  raw: ContactSearchResult
): ContactSearchResult {
  const website = raw.website ? ensureProtocol(raw.website) : undefined;

  const validContacts: ContactInput[] = raw.contacts.filter((contact) => {
    const hasValidEmail = contact.email ? isValidEmail(contact.email) : false;
    const hasPhone = !!contact.phone;
    const hasPageUrl = !!contact.contactPageUrl;

    // Keep the contact if it has at least one actionable piece of info
    return hasValidEmail || hasPhone || hasPageUrl;
  });

  return {
    manufacturer: raw.manufacturer,
    website,
    contacts: validContacts,
  };
}

/**
 * Format a prompt for Claude Code sub-agents to search for manufacturer contacts.
 *
 * This generates the instructions that a sub-agent receives when tasked with
 * finding contact information for a specific manufacturer.
 *
 * @param manufacturer - The manufacturer/brand name.
 * @param website - Optional known website for the manufacturer.
 * @returns Formatted prompt string for the sub-agent.
 */
export function formatSearchAgentPrompt(
  manufacturer: string,
  website?: string
): string {
  const safe = sanitizeManufacturerName(manufacturer);
  const websiteHint = website
    ? `Their known website is ${website}. Check it for a contact/press page.`
    : "";

  return `Search the web for contact information for the brand/company "${safe}". ${websiteHint}

I need the following types of contact info, in order of priority:
1. **Media/PR email** — for press inquiries, media relations
2. **Promotions/partnerships email** — for brand collaborations, sponsorships
3. **General contact email** — any public contact email
4. **Contact page URL** — the brand's official contact or press page
5. **Phone number** — if easily found

Return the results as a JSON object matching this structure:
\`\`\`json
{
  "manufacturer": "${safe}",
  "website": "https://www.example.com",
  "contacts": [
    {
      "contactType": "media",
      "email": "press@example.com",
      "contactPageUrl": "https://www.example.com/press",
      "sourceUrl": "https://where-you-found-this.com",
      "confidence": "high",
      "notes": "Found on official press page"
    }
  ]
}
\`\`\`

Valid contactType values: "media", "promotions", "pr", "partnerships", "general", "support"
Valid confidence values: "high" (official source), "medium" (reputable third-party), "low" (uncertain)

Search thoroughly but return only what you can actually find. Do not fabricate contact info.`;
}
