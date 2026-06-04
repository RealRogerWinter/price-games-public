/**
 * Outbound link origin registry — single source of truth for the
 * `(utm_source, utm_medium, utm_campaign, utm_content?)` tuple that every
 * outgoing email and push notification stamps onto its URLs.
 *
 * Each origin key identifies a specific email or push template type. The
 * origin's UTM tuple flows through the server-side `outboundLinks` service:
 *   - URLs in email bodies are rewritten to short codes (or long UTM URLs
 *     for per-recipient tokenized links).
 *   - URLs in push payloads are pre-tagged with UTMs so the landing-page
 *     attribution capture (apps/web/src/utils/attribution.ts) can record
 *     which campaign drove the visit.
 *
 * Why per-template granularity (not per-recipient): aggregate tracking is
 * what the admin funnel needs; per-recipient short codes would grow the
 * `utm_tags` table by ~thousands of rows per day with no analytic gain.
 */

import type { EmailNotificationType, NotificationType } from "./types.js";

/**
 * Every supported origin. Naming convention:
 *   - `email:<campaign>` for emails
 *   - `push:<type>` for push notifications
 *   - reminder cadences disambiguate via the `_15d`/`_7d`/`_1d` suffix so
 *     the funnel can split by remaining-days bucket
 */
export type OutboundOriginKey =
  | "email:verify"
  | "email:password_reset"
  | "email:reward_awarded"
  | "email:reward_reminder_15d"
  | "email:reward_reminder_7d"
  | "email:reward_reminder_1d"
  | "email:reward_expired"
  | "email:giveaway_loss"
  | "email:streak_risk"
  | "email:streak_save"
  | "email:inactivity_reminder"
  | "email:weekly_digest"
  | "email:leaderboard_placement"
  | "email:promotional"
  | "email:custom"
  | "push:daily_puzzle"
  | "push:streak_reminder"
  | "push:leaderboard_updates"
  | "push:leaderboard_placement"
  | "push:multiplayer_invites"
  | "push:promotional";

/** UTM tuple stamped onto links emitted under this origin. */
export interface OutboundOriginSpec {
  source: string;
  medium: string;
  campaign: string;
  /** Optional sub-bucket. Used for reminder cadences (15d/7d/1d). */
  content?: string;
}

/**
 * Origin → UTM tuple map. Mediums are taxonomic:
 *   - `transactional`: system-generated in response to a user action
 *     (verify email, password reset, reward award + reminders + expiry).
 *   - `lifecycle`: automated re-engagement based on user state
 *     (streak risk/save, inactivity, weekly digest, leaderboard
 *     placement, giveaway-loss consolation).
 *   - `marketing`: admin-driven broadcasts (promotional, custom).
 *   - `web_push`: push-channel medium for all push types.
 *
 * Campaign names match the existing `EmailNotificationType` / push
 * `NotificationType` identifiers wherever possible so admin funnel
 * filters compose naturally.
 */
export const OUTBOUND_ORIGINS: Record<OutboundOriginKey, OutboundOriginSpec> = {
  "email:verify":                 { source: "email", medium: "transactional", campaign: "verify_email" },
  "email:password_reset":         { source: "email", medium: "transactional", campaign: "password_reset" },
  "email:reward_awarded":         { source: "email", medium: "transactional", campaign: "reward_awarded" },
  "email:reward_reminder_15d":    { source: "email", medium: "transactional", campaign: "reward_reminder", content: "15d" },
  "email:reward_reminder_7d":     { source: "email", medium: "transactional", campaign: "reward_reminder", content: "7d" },
  "email:reward_reminder_1d":     { source: "email", medium: "transactional", campaign: "reward_reminder", content: "1d" },
  "email:reward_expired":         { source: "email", medium: "transactional", campaign: "reward_expired" },
  "email:giveaway_loss":          { source: "email", medium: "lifecycle",     campaign: "giveaway_loss" },
  "email:streak_risk":            { source: "email", medium: "lifecycle",     campaign: "streak_risk" },
  "email:streak_save":            { source: "email", medium: "lifecycle",     campaign: "streak_save" },
  "email:inactivity_reminder":    { source: "email", medium: "lifecycle",     campaign: "inactivity_reminder" },
  "email:weekly_digest":          { source: "email", medium: "lifecycle",     campaign: "weekly_digest" },
  "email:leaderboard_placement":  { source: "email", medium: "lifecycle",     campaign: "leaderboard_placement" },
  "email:promotional":            { source: "email", medium: "marketing",     campaign: "promotional" },
  "email:custom":                 { source: "email", medium: "marketing",     campaign: "custom" },
  "push:daily_puzzle":            { source: "push",  medium: "web_push",      campaign: "daily_puzzle" },
  "push:streak_reminder":         { source: "push",  medium: "web_push",      campaign: "streak_reminder" },
  "push:leaderboard_updates":     { source: "push",  medium: "web_push",      campaign: "leaderboard_updates" },
  "push:leaderboard_placement":   { source: "push",  medium: "web_push",      campaign: "leaderboard_placement" },
  "push:multiplayer_invites":     { source: "push",  medium: "web_push",      campaign: "multiplayer_invites" },
  "push:promotional":             { source: "push",  medium: "web_push",      campaign: "promotional" },
};

/**
 * Resolve the origin key for a marketing-email type. The mapping is
 * one-to-one — every `EmailNotificationType` has a corresponding origin.
 *
 * @param type - The email notification type.
 * @returns The origin key for use with the outbound-links service.
 */
export function originForEmailType(type: EmailNotificationType): OutboundOriginKey {
  switch (type) {
    case "streak_risk":           return "email:streak_risk";
    case "streak_save":           return "email:streak_save";
    case "inactivity_reminder":   return "email:inactivity_reminder";
    case "weekly_digest":         return "email:weekly_digest";
    case "leaderboard_placement": return "email:leaderboard_placement";
    case "promotional":           return "email:promotional";
    case "giveaway_loss":         return "email:giveaway_loss";
    case "custom":                return "email:custom";
  }
}

/**
 * Resolve the origin key for a push-notification type. The mapping is
 * one-to-one — every `NotificationType` has a corresponding origin.
 *
 * @param type - The push notification type.
 * @returns The origin key for use with the outbound-links service.
 */
export function originForNotificationType(type: NotificationType): OutboundOriginKey {
  switch (type) {
    case "daily_puzzle":          return "push:daily_puzzle";
    case "streak_reminder":       return "push:streak_reminder";
    case "leaderboard_updates":   return "push:leaderboard_updates";
    case "leaderboard_placement": return "push:leaderboard_placement";
    case "multiplayer_invites":   return "push:multiplayer_invites";
    case "promotional":           return "push:promotional";
  }
}
