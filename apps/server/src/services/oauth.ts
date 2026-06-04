/**
 * OAuth authentication service.
 * Handles Google, Facebook, and Amazon OAuth 2.0 authorization code flows.
 */

import crypto from "crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config";
import { rowToUserAccount } from "./userAuth";
import type { UserAccount } from "@price-game/shared";
import { UserFacingError } from "./errors";
import { evictOldestSessions, recordSuccessfulLogin } from "./authHelpers";

/** Sentinel password hash for OAuth-only users (cannot match any bcrypt hash). */
const OAUTH_NO_PASSWORD = "OAUTH_NO_PASSWORD";

/** Maximum number of pending CSRF states to prevent memory exhaustion. */
const MAX_PENDING_STATES = 10_000;

/** Facebook Graph API version — update when migrating to a newer version. */
const FB_API_VERSION = "v19.0";

// In-memory CSRF state store (short-lived)
const pendingStates = new Map<string, { provider: string; expiresAt: number }>();

// Cleanup expired states every 5 minutes (skip in test to avoid open handles)
if (process.env.NODE_ENV !== "test") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of pendingStates) {
      if (val.expiresAt < now) pendingStates.delete(key);
    }
  }, 5 * 60 * 1000);
}

/**
 * Generate a cryptographically random CSRF state token for an OAuth flow.
 *
 * Enforces a maximum map size to prevent memory exhaustion from excessive
 * OAuth initiation requests.
 *
 * @param provider - The OAuth provider name (e.g. "google", "facebook").
 * @returns A hex-encoded random state string.
 * @throws UserFacingError if the pending state limit is exceeded.
 */
export function generateOAuthState(provider: string): string {
  if (pendingStates.size >= MAX_PENDING_STATES) {
    // Evict expired entries first
    const now = Date.now();
    for (const [key, val] of pendingStates) {
      if (val.expiresAt < now) pendingStates.delete(key);
    }
    if (pendingStates.size >= MAX_PENDING_STATES) {
      throw new UserFacingError("Too many pending OAuth requests, please try again later");
    }
  }
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.set(state, { provider, expiresAt: Date.now() + 10 * 60 * 1000 });
  return state;
}

/**
 * Validate and consume an OAuth CSRF state token.
 *
 * Checks that the state exists, matches the expected provider, and has not
 * expired. The token is consumed (deleted) on success or expiry.
 *
 * @param state - The state token from the OAuth callback.
 * @param provider - The expected OAuth provider name.
 * @returns true if the state is valid, false otherwise.
 */
export function validateOAuthState(state: string, provider: string): boolean {
  const entry = pendingStates.get(state);
  if (!entry) return false;
  if (entry.provider !== provider) return false;
  if (entry.expiresAt < Date.now()) {
    pendingStates.delete(state);
    return false;
  }
  pendingStates.delete(state);
  return true;
}

// -- Google --

/**
 * Build the Google OAuth 2.0 authorization URL.
 *
 * @param state - CSRF state token to include in the request.
 * @returns The full Google authorization URL.
 */
export function getGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: `${config.oauthCallbackBase}/api/user/oauth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchange a Google authorization code for user profile information.
 *
 * Calls the Google token endpoint, then fetches the user's profile from
 * the userinfo API using the access token. Rejects profiles with unverified
 * email addresses.
 *
 * @param code - The authorization code from Google's callback.
 * @returns An object with the user's email, name, and Google provider ID.
 * @throws UserFacingError if the token exchange or profile fetch fails, or
 *         if the email is not verified.
 */
export async function exchangeGoogleCode(code: string): Promise<{ email: string; name: string; providerId: string }> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: `${config.oauthCallbackBase}/api/user/oauth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new UserFacingError("Failed to exchange Google authorization code");
  }
  const tokens = (await tokenRes.json()) as { access_token: string };

  const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    throw new UserFacingError("Failed to fetch Google profile");
  }
  const profile = (await profileRes.json()) as { id: string; email: string; name: string; verified_email?: boolean };
  if (profile.verified_email !== true) {
    throw new UserFacingError("Google email is not verified");
  }
  return { email: profile.email, name: profile.name, providerId: profile.id };
}

// -- Facebook --

/**
 * Build the Facebook OAuth 2.0 authorization URL.
 *
 * @param state - CSRF state token to include in the request.
 * @returns The full Facebook authorization URL.
 */
export function getFacebookAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.facebookAppId,
    redirect_uri: `${config.oauthCallbackBase}/api/user/oauth/facebook/callback`,
    response_type: "code",
    scope: "email,public_profile",
    state,
  });
  return `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?${params}`;
}

/**
 * Exchange a Facebook authorization code for user profile information.
 *
 * Calls the Facebook token endpoint, then fetches the user's profile from
 * the Graph API using the Authorization header (not query param, to avoid
 * leaking the token in server/proxy access logs).
 *
 * @param code - The authorization code from Facebook's callback.
 * @returns An object with the user's email, name, and Facebook provider ID.
 * @throws UserFacingError if the token exchange or profile fetch fails, or if the account has no email.
 */
export async function exchangeFacebookCode(code: string): Promise<{ email: string; name: string; providerId: string }> {
  const tokenRes = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.facebookAppId,
      client_secret: config.facebookAppSecret,
      redirect_uri: `${config.oauthCallbackBase}/api/user/oauth/facebook/callback`,
      code,
    }),
  });
  if (!tokenRes.ok) {
    throw new UserFacingError("Failed to exchange Facebook authorization code");
  }
  const tokens = (await tokenRes.json()) as { access_token: string };

  // Use Authorization header instead of query param to avoid token leakage in logs
  const profileRes = await fetch(
    `https://graph.facebook.com/${FB_API_VERSION}/me?fields=id,name,email`,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  if (!profileRes.ok) {
    throw new UserFacingError("Failed to fetch Facebook profile");
  }
  const profile = (await profileRes.json()) as { id: string; email?: string; name: string };
  if (!profile.email) {
    throw new UserFacingError("Facebook account does not have an email address");
  }
  return { email: profile.email, name: profile.name, providerId: profile.id };
}

// -- Amazon --

/**
 * Build the Amazon (Login with Amazon) OAuth 2.0 authorization URL.
 *
 * @param state - CSRF state token to include in the request.
 * @returns The full Amazon authorization URL.
 */
export function getAmazonAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.amazonClientId,
    redirect_uri: `${config.oauthCallbackBase}/api/user/oauth/amazon/callback`,
    response_type: "code",
    scope: "profile",
    state,
  });
  return `https://www.amazon.com/ap/oa?${params}`;
}

/**
 * Exchange an Amazon authorization code for user profile information.
 *
 * Calls the Amazon token endpoint, then fetches the user's profile from
 * the user profile API using the Authorization header.
 *
 * @param code - The authorization code from Amazon's callback.
 * @returns An object with the user's email, name, and Amazon provider ID.
 * @throws UserFacingError if the token exchange or profile fetch fails, or
 *         if the account has no email.
 */
export async function exchangeAmazonCode(code: string): Promise<{ email: string; name: string; providerId: string }> {
  const tokenRes = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.amazonClientId,
      client_secret: config.amazonClientSecret,
      redirect_uri: `${config.oauthCallbackBase}/api/user/oauth/amazon/callback`,
    }),
  });
  if (!tokenRes.ok) {
    throw new UserFacingError("Failed to exchange Amazon authorization code");
  }
  const tokens = (await tokenRes.json()) as { access_token: string };

  // Use Authorization header to avoid token leakage in logs
  const profileRes = await fetch("https://api.amazon.com/user/profile", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    throw new UserFacingError("Failed to fetch Amazon profile");
  }
  const profile = (await profileRes.json()) as { user_id: string; email?: string; name: string };
  if (!profile.email) {
    throw new UserFacingError("Amazon account does not have an email address");
  }
  return { email: profile.email, name: profile.name, providerId: profile.user_id };
}

// -- Shared: find or create user from OAuth profile --

/**
 * Find an existing user by OAuth provider or email, or create a new one.
 *
 * Lookup order:
 * 1. Match by oauth_provider + oauth_provider_id (returning user).
 * 2. Match by email (case-insensitive) — only links if the existing account
 *    has no OAuth provider already set, to prevent overwriting a prior link.
 * 3. Create a brand-new user with a generated username and a sentinel
 *    password hash (OAUTH_NO_PASSWORD).
 *
 * @param db - Database instance.
 * @param provider - OAuth provider name (e.g. "google", "facebook").
 * @param providerId - The user's unique ID from the provider.
 * @param email - The user's email address from the provider.
 * @param name - The user's display name from the provider.
 * @returns An object with the UserAccount and whether it was newly created.
 */
export function findOrCreateOAuthUser(
  db: DatabaseType,
  provider: string,
  providerId: string,
  email: string,
  name: string,
): { user: UserAccount; isNew: boolean } {
  return db.transaction(() => {
    // 1. Check if there's already a user linked to this OAuth provider+id
    const existingOAuth = db
      .prepare("SELECT * FROM users WHERE oauth_provider = ? AND oauth_provider_id = ?")
      .get(provider, providerId) as Record<string, unknown> | undefined;

    if (existingOAuth) {
      return { user: rowToUserAccount(existingOAuth), isNew: false };
    }

    // 2. Check if there's a user with the same email — only link if that
    //    account has a verified email, to prevent account-takeover via
    //    an unverified email claim from the OAuth provider.
    const existingEmail = db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email.toLowerCase()) as Record<string, unknown> | undefined;

    if (existingEmail) {
      // Only link OAuth provider if: (a) no prior link, and (b) email is verified
      if (!existingEmail.oauth_provider && (existingEmail.email_verified as number) === 1) {
        db.prepare("UPDATE users SET oauth_provider = ?, oauth_provider_id = ? WHERE id = ? AND oauth_provider IS NULL")
          .run(provider, providerId, existingEmail.id as string);
        const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(existingEmail.id as string) as Record<string, unknown>;
        return { user: rowToUserAccount(updated), isNew: false };
      }
      // Account exists (either already has an OAuth link, or email is unverified) —
      // return the existing user without linking to avoid creating a duplicate.
      return { user: rowToUserAccount(existingEmail), isNew: false };
    }

    // 3. Create a new user with UUID-suffixed username to avoid collisions
    const id = uuidv4();
    const now = new Date().toISOString();
    let username = name.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 16);
    if (username.length < 3) username = username + "_user";

    const normalizedUsername = username.toLowerCase();
    const conflict = db
      .prepare("SELECT id FROM users WHERE username_normalized = ?")
      .get(normalizedUsername);
    if (conflict) {
      // Append first 8 chars of UUID for uniqueness
      username = username.substring(0, 10) + "_" + id.substring(0, 8);
    }

    db.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, email_verified, oauth_provider, oauth_provider_id, created_at, updated_at, is_active, username_pending)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, 1)`,
    ).run(id, username, username.toLowerCase(), email.toLowerCase(), OAUTH_NO_PASSWORD, provider, providerId, now, now);

    const created = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>;
    return { user: rowToUserAccount(created), isNew: true };
  })();
}

// -- Session creation for OAuth users --

/**
 * Create a new session for an OAuth-authenticated user.
 *
 * Enforces the maximum concurrent sessions limit by evicting the oldest
 * sessions when necessary. Updates last_login_at on the user record.
 *
 * @param db - Database instance.
 * @param userId - The user's id.
 * @param ip - Optional IP address for the session.
 * @param userAgent - Optional user-agent string for the session.
 * @returns The session token.
 */
export function createOAuthSession(
  db: DatabaseType,
  userId: string,
  ip?: string,
  userAgent?: string,
): string {
  const now = new Date().toISOString();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + config.userSessionDurationMs).toISOString();

  // Enforce max sessions
  evictOldestSessions(db, userId, config.userMaxSessions);

  db.prepare(
    `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(token, userId, ip ?? null, userAgent ?? null, now, expiresAt, now);

  // Update last_login_at (also resets failed_login_count/locked_until for linked accounts)
  recordSuccessfulLogin(db, "users", userId);

  return token;
}
