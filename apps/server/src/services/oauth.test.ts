/**
 * Tests for OAuth authentication service.
 * Covers CSRF state management, findOrCreateOAuthUser, and createOAuthSession.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  generateOAuthState,
  validateOAuthState,
  getGoogleAuthUrl,
  getFacebookAuthUrl,
  getAmazonAuthUrl,
  findOrCreateOAuthUser,
  createOAuthSession,
  exchangeGoogleCode,
  exchangeFacebookCode,
  exchangeAmazonCode,
} from "./oauth";
import { UserFacingError } from "./errors";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

// ── CSRF State Management ─────────────────────────────────────────────

describe("generateOAuthState / validateOAuthState", () => {
  it("generates a hex state token", () => {
    const state = generateOAuthState("google");
    expect(state).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates a state token for the correct provider", () => {
    const state = generateOAuthState("google");
    expect(validateOAuthState(state, "google")).toBe(true);
  });

  it("consumes state token on validation (single use)", () => {
    const state = generateOAuthState("google");
    expect(validateOAuthState(state, "google")).toBe(true);
    expect(validateOAuthState(state, "google")).toBe(false);
  });

  it("rejects state for wrong provider", () => {
    const state = generateOAuthState("google");
    expect(validateOAuthState(state, "facebook")).toBe(false);
  });

  it("rejects unknown state token", () => {
    expect(validateOAuthState("nonexistent", "google")).toBe(false);
  });

  it("generates unique tokens", () => {
    const a = generateOAuthState("google");
    const b = generateOAuthState("google");
    expect(a).not.toBe(b);
  });
});

// ── Auth URL builders ─────────────────────────────────────────────────

describe("getGoogleAuthUrl", () => {
  it("returns a Google OAuth URL with required params", () => {
    const url = getGoogleAuthUrl("test-state");
    expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url).toContain("state=test-state");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=openid+email+profile");
  });
});

describe("getFacebookAuthUrl", () => {
  it("returns a Facebook OAuth URL with required params", () => {
    const url = getFacebookAuthUrl("test-state");
    expect(url).toContain("https://www.facebook.com/v19.0/dialog/oauth");
    expect(url).toContain("state=test-state");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=email");
  });
});

describe("getAmazonAuthUrl", () => {
  it("returns an Amazon OAuth URL with required params", () => {
    const url = getAmazonAuthUrl("test-state");
    expect(url).toContain("https://www.amazon.com/ap/oa");
    expect(url).toContain("state=test-state");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=profile");
  });
});

// ── findOrCreateOAuthUser ─────────────────────────────────────────────

describe("findOrCreateOAuthUser", () => {
  it("creates a new user when no match exists", () => {
    const { user, isNew } = findOrCreateOAuthUser(
      db, "google", "g-123", "new@example.com", "Test User",
    );
    expect(isNew).toBe(true);
    expect(user.email).toBe("new@example.com");
    expect(user.emailVerified).toBe(false); // OAuth users must verify email
    expect(user.isActive).toBe(true);
  });

  it("generates a username from the OAuth name", () => {
    const { user } = findOrCreateOAuthUser(
      db, "google", "g-123", "test@example.com", "John Doe",
    );
    // Spaces replaced with underscores
    expect(user.username).toMatch(/^John_Doe/);
  });

  it("handles names with special characters", () => {
    const { user } = findOrCreateOAuthUser(
      db, "google", "g-123", "test@example.com", "José María!",
    );
    // Non-alphanumeric chars (except underscore) are replaced
    expect(user.username).toMatch(/^[a-zA-Z0-9_]+$/);
  });

  it("pads short usernames", () => {
    const { user } = findOrCreateOAuthUser(
      db, "google", "g-123", "test@example.com", "AB",
    );
    expect(user.username.length).toBeGreaterThanOrEqual(3);
  });

  it("returns existing user when matched by provider+id", () => {
    const first = findOrCreateOAuthUser(
      db, "google", "g-123", "test@example.com", "Test User",
    );
    const second = findOrCreateOAuthUser(
      db, "google", "g-123", "test@example.com", "Test User",
    );
    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it("links OAuth to existing user when matched by email (no prior OAuth)", () => {
    // Create a regular user first (no oauth_provider set) with verified email
    const userId = seedUser(db, "existing", "shared@example.com");
    db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(userId);

    const { user, isNew } = findOrCreateOAuthUser(
      db, "google", "g-456", "shared@example.com", "Google User",
    );
    expect(isNew).toBe(false);
    expect(user.id).toBe(userId);

    // Verify OAuth provider was linked
    const row = db.prepare("SELECT oauth_provider, oauth_provider_id FROM users WHERE id = ?")
      .get(userId) as { oauth_provider: string; oauth_provider_id: string };
    expect(row.oauth_provider).toBe("google");
    expect(row.oauth_provider_id).toBe("g-456");
  });

  it("does not link OAuth to existing user with unverified email", () => {
    // Create a regular user with unverified email (default)
    const userId = seedUser(db, "unverified", "unverified@example.com");

    const { user, isNew } = findOrCreateOAuthUser(
      db, "google", "g-unv", "unverified@example.com", "Google User",
    );
    // Returns existing user but does NOT link the OAuth provider
    expect(isNew).toBe(false);
    expect(user.id).toBe(userId);

    const row = db.prepare("SELECT oauth_provider FROM users WHERE id = ?")
      .get(userId) as { oauth_provider: string | null };
    expect(row.oauth_provider).toBeNull();
  });

  it("does not overwrite existing OAuth link when matched by email", () => {
    // Create a user linked to Google
    findOrCreateOAuthUser(db, "google", "g-100", "multi@example.com", "Multi User");

    // Try to link Facebook with the same email — should NOT overwrite Google
    const { user, isNew } = findOrCreateOAuthUser(
      db, "facebook", "fb-200", "multi@example.com", "Multi User",
    );
    expect(isNew).toBe(false);

    // Google link should still be intact
    const row = db.prepare("SELECT oauth_provider, oauth_provider_id FROM users WHERE id = ?")
      .get(user.id) as { oauth_provider: string; oauth_provider_id: string };
    expect(row.oauth_provider).toBe("google");
    expect(row.oauth_provider_id).toBe("g-100");
  });

  it("stores OAUTH_NO_PASSWORD as password hash for new OAuth users", () => {
    const { user } = findOrCreateOAuthUser(
      db, "google", "g-123", "test@example.com", "Test User",
    );
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(user.id) as { password_hash: string };
    expect(row.password_hash).toBe("OAUTH_NO_PASSWORD");
  });

  it("handles username collision on creation", () => {
    // Create a user with username "TestUser"
    seedUser(db, "TestUser", "first@example.com");

    // OAuth user with same name should get a unique username
    const { user } = findOrCreateOAuthUser(
      db, "google", "g-789", "second@example.com", "TestUser",
    );
    expect(user.username).not.toBe("TestUser");
    expect(user.username).toMatch(/^TestUser/);
  });

  it("handles email case-insensitively", () => {
    const userId = seedUser(db, "existing", "Test@Example.com");
    db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(userId);

    const { user, isNew } = findOrCreateOAuthUser(
      db, "google", "g-456", "test@example.com", "Google User",
    );
    expect(isNew).toBe(false);
    expect(user.id).toBe(userId);
  });
});

// ── createOAuthSession ────────────────────────────────────────────────

describe("createOAuthSession", () => {
  it("creates a session and returns a token", () => {
    const userId = seedUser(db);
    const token = createOAuthSession(db, userId, "127.0.0.1", "test-agent");

    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const session = db.prepare("SELECT * FROM user_sessions WHERE id = ?")
      .get(token) as Record<string, unknown>;
    expect(session).toBeDefined();
    expect(session.user_id).toBe(userId);
    expect(session.ip_address).toBe("127.0.0.1");
    expect(session.user_agent).toBe("test-agent");
  });

  it("updates last_login_at on the user", () => {
    const userId = seedUser(db);

    const before = db.prepare("SELECT last_login_at FROM users WHERE id = ?")
      .get(userId) as { last_login_at: string | null };
    expect(before.last_login_at).toBeNull();

    createOAuthSession(db, userId);

    const after = db.prepare("SELECT last_login_at FROM users WHERE id = ?")
      .get(userId) as { last_login_at: string };
    expect(after.last_login_at).toBeTruthy();
  });

  it("evicts oldest sessions when max is exceeded", () => {
    const userId = seedUser(db);

    // Create max sessions
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      tokens.push(createOAuthSession(db, userId));
    }

    // All 5 should exist
    const countBefore = db.prepare("SELECT COUNT(*) as cnt FROM user_sessions WHERE user_id = ?")
      .get(userId) as { cnt: number };
    expect(countBefore.cnt).toBe(5);

    // Create one more — oldest should be evicted
    createOAuthSession(db, userId);

    const countAfter = db.prepare("SELECT COUNT(*) as cnt FROM user_sessions WHERE user_id = ?")
      .get(userId) as { cnt: number };
    expect(countAfter.cnt).toBe(5);

    // Oldest token should be gone
    const oldest = db.prepare("SELECT id FROM user_sessions WHERE id = ?").get(tokens[0]);
    expect(oldest).toBeUndefined();
  });

  it("works without optional ip and userAgent", () => {
    const userId = seedUser(db);
    const token = createOAuthSession(db, userId);
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const session = db.prepare("SELECT * FROM user_sessions WHERE id = ?")
      .get(token) as Record<string, unknown>;
    expect(session.ip_address).toBeNull();
    expect(session.user_agent).toBeNull();
  });
});

// ── exchangeGoogleCode ──────────────────────────────────────────────

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("exchangeGoogleCode", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns email, name, and providerId on success", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "google-123",
          email: "user@gmail.com",
          name: "Test User",
          verified_email: true,
        }),
      });

    const result = await exchangeGoogleCode("auth-code");
    expect(result).toEqual({
      email: "user@gmail.com",
      name: "Test User",
      providerId: "google-123",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws UserFacingError when token exchange fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });

    const err = await exchangeGoogleCode("bad-code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Failed to exchange Google authorization code");
  });

  it("throws UserFacingError when profile fetch fails", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

    const err = await exchangeGoogleCode("auth-code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Failed to fetch Google profile");
  });

  it("throws UserFacingError when email is not verified", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "test-token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "google-123",
          email: "user@gmail.com",
          name: "Test User",
          verified_email: false,
        }),
      });

    const err = await exchangeGoogleCode("auth-code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Google email is not verified");
  });
});

// ── exchangeFacebookCode ────────────────────────────────────────────

describe("exchangeFacebookCode", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns email, name, and providerId on success", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "fb-test-token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "fb-123",
          email: "user@facebook.com",
          name: "FB User",
        }),
      });

    const result = await exchangeFacebookCode("auth-code");
    expect(result).toEqual({
      email: "user@facebook.com",
      name: "FB User",
      providerId: "fb-123",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws UserFacingError when token exchange fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });

    const err = await exchangeFacebookCode("bad-code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Failed to exchange Facebook authorization code");
  });

  it("throws UserFacingError when profile fetch fails", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "fb-test-token" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

    const err = await exchangeFacebookCode("auth-code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Failed to fetch Facebook profile");
  });

  it("throws UserFacingError when email is missing", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "fb-test-token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "fb-123",
          name: "FB User",
        }),
      });

    const err = await exchangeFacebookCode("auth-code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Facebook account does not have an email address");
  });
});

// ── exchangeAmazonCode ──────────────────────────────────────────────

describe("exchangeAmazonCode", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns email, name, and providerId on success", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "amzn-test-token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user_id: "amzn-123",
          email: "user@amazon.com",
          name: "Amazon User",
        }),
      });

    const result = await exchangeAmazonCode("auth-code");
    expect(result).toEqual({
      email: "user@amazon.com",
      name: "Amazon User",
      providerId: "amzn-123",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws UserFacingError when token exchange fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });

    const err = await exchangeAmazonCode("bad-code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Failed to exchange Amazon authorization code");
  });

  it("throws UserFacingError when profile fetch fails", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "amzn-test-token" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

    const err = await exchangeAmazonCode("auth-code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Failed to fetch Amazon profile");
  });

  it("throws UserFacingError when email is missing", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "amzn-test-token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user_id: "amzn-123",
          name: "Amazon User",
        }),
      });

    const err = await exchangeAmazonCode("auth-code").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe("Amazon account does not have an email address");
  });
});
