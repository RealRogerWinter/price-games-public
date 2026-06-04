import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import * as OTPAuth from "otpauth";
import { createTestDb, seedAdminUser } from "../test/dbHelper";
import {
  isTotpEnabled,
  getTotpStatus,
  beginTotpSetup,
  verifyAndEnableTotp,
  verifyTotpCode,
  verifyRecoveryCodeAndConsume,
  disableTotp,
  regenerateRecoveryCodes,
  createPendingTotpToken,
  validateAndConsumePendingToken,
  cleanupExpiredPendingTokens,
  logAuditEvent,
  _testing,
} from "./adminTotp";

const { encryptSecret, decryptSecret, generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode } = _testing;

// ADMIN_2FA_ENCRYPTION_KEY is set in vitest.config.ts env

let db: DatabaseType;
let adminId: string;

beforeEach(() => {
  db = createTestDb();
  adminId = seedAdminUser(db, "admin", "testpassword123", false, false);
});

// ── Encryption helpers ─────────────────────────────────────────────────────

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret correctly", () => {
    const plaintext = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).toMatch(/^v1:[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const plaintext = "JBSWY3DPEHPK3PXP";
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
  });

  it("throws on invalid format", () => {
    expect(() => decryptSecret("bad-format")).toThrow("Invalid encrypted secret format");
  });
});

// ── Recovery code helpers ──────────────────────────────────────────────────

describe("recovery code helpers", () => {
  it("generates codes of correct length and character set", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
    }
  });

  it("generates unique codes", () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
  });

  it("hashes and verifies a code correctly", () => {
    const code = "ABCD1234";
    const { hash, salt } = hashRecoveryCode(code);
    expect(verifyRecoveryCode(code, hash, salt)).toBe(true);
    expect(verifyRecoveryCode("WRONG123", hash, salt)).toBe(false);
  });

  it("verifies case-insensitively", () => {
    const code = "ABCDEFGH";
    const { hash, salt } = hashRecoveryCode(code);
    expect(verifyRecoveryCode("abcdefgh", hash, salt)).toBe(true);
  });

  it("strips whitespace before verifying", () => {
    const code = "ABCDEFGH";
    const { hash, salt } = hashRecoveryCode(code);
    expect(verifyRecoveryCode("ABCD EFGH", hash, salt)).toBe(true);
  });
});

// ── isTotpEnabled ──────────────────────────────────────────────────────────

describe("isTotpEnabled", () => {
  it("returns false for new admin", () => {
    expect(isTotpEnabled(db, adminId)).toBe(false);
  });

  it("returns true when enabled with a secret", () => {
    db.prepare("UPDATE admin_users SET totp_enabled = 1, totp_secret_encrypted = 'v1:test' WHERE id = ?").run(adminId);
    expect(isTotpEnabled(db, adminId)).toBe(true);
  });

  it("returns false when enabled flag set but no secret", () => {
    db.prepare("UPDATE admin_users SET totp_enabled = 1 WHERE id = ?").run(adminId);
    expect(isTotpEnabled(db, adminId)).toBe(false);
  });
});

// ── getTotpStatus ──────────────────────────────────────────────────────────

describe("getTotpStatus", () => {
  it("returns disabled status for new admin", () => {
    const status = getTotpStatus(db, adminId);
    expect(status.enabled).toBe(false);
    expect(status.enabledAt).toBeNull();
    expect(status.recoveryCodesRemaining).toBe(0);
  });
});

// ── beginTotpSetup ─────────────────────────────────────────────────────────

describe("beginTotpSetup", () => {
  it("returns QR code, secret, and URI", async () => {
    const result = await beginTotpSetup(db, adminId);
    expect(result.secret).toBeTruthy();
    expect(result.otpauthUri).toContain("otpauth://totp/");
    expect(result.otpauthUri).toContain("PriceGames%20Admin");
    expect(result.qrCodeDataUrl).toContain("data:image/png;base64,");
  });

  it("stores encrypted secret in DB but does not enable 2FA", async () => {
    await beginTotpSetup(db, adminId);
    const row = db.prepare("SELECT totp_secret_encrypted, totp_enabled FROM admin_users WHERE id = ?").get(adminId) as Record<string, unknown>;
    expect(row.totp_secret_encrypted).toBeTruthy();
    expect(row.totp_enabled).toBe(0);
  });

  it("logs audit event", async () => {
    await beginTotpSetup(db, adminId);
    const events = db.prepare("SELECT event FROM admin_2fa_audit_log WHERE admin_user_id = ?").all(adminId) as { event: string }[];
    expect(events.some((e) => e.event === "2fa_setup_started")).toBe(true);
  });

  it("reuses existing pending secret on repeated calls", async () => {
    const first = await beginTotpSetup(db, adminId);
    const second = await beginTotpSetup(db, adminId);
    expect(second.secret).toBe(first.secret);
    expect(second.otpauthUri).toBe(first.otpauthUri);
  });

  it("throws for non-existent admin", async () => {
    await expect(beginTotpSetup(db, "non-existent")).rejects.toThrow("Admin user not found");
  });

  it("throws if 2FA is already enabled", async () => {
    const setup = await beginTotpSetup(db, adminId);
    const totp = new OTPAuth.TOTP({
      issuer: "PriceGames Admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(setup.secret),
    });
    verifyAndEnableTotp(db, adminId, totp.generate());
    await expect(beginTotpSetup(db, adminId)).rejects.toThrow("2FA is already enabled");
  });
});

// ── verifyAndEnableTotp ────────────────────────────────────────────────────

describe("verifyAndEnableTotp", () => {
  let secret: string;

  beforeEach(async () => {
    const setup = await beginTotpSetup(db, adminId);
    secret = setup.secret;
  });

  function generateValidCode(): string {
    const totp = new OTPAuth.TOTP({
      issuer: "PriceGames Admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    return totp.generate();
  }

  it("enables 2FA and returns recovery codes on valid code", () => {
    const code = generateValidCode();
    const result = verifyAndEnableTotp(db, adminId, code);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(isTotpEnabled(db, adminId)).toBe(true);
  });

  it("throws on invalid code", () => {
    expect(() => verifyAndEnableTotp(db, adminId, "000000")).toThrow("Invalid verification code");
    expect(isTotpEnabled(db, adminId)).toBe(false);
  });

  it("throws if already enabled", () => {
    const code = generateValidCode();
    verifyAndEnableTotp(db, adminId, code);
    // Generate another code for the second attempt
    const code2 = generateValidCode();
    expect(() => verifyAndEnableTotp(db, adminId, code2)).toThrow("2FA is already enabled");
  });

  it("throws if no pending secret", () => {
    // Clear the secret
    db.prepare("UPDATE admin_users SET totp_secret_encrypted = NULL WHERE id = ?").run(adminId);
    expect(() => verifyAndEnableTotp(db, adminId, "123456")).toThrow("No pending 2FA setup found");
  });

  it("stores hashed recovery codes in the database", () => {
    const code = generateValidCode();
    verifyAndEnableTotp(db, adminId, code);
    const rows = db.prepare("SELECT * FROM admin_2fa_recovery_codes WHERE admin_user_id = ?").all(adminId);
    expect(rows).toHaveLength(10);
  });
});

// ── verifyTotpCode ─────────────────────────────────────────────────────────

describe("verifyTotpCode", () => {
  let secret: string;

  beforeEach(async () => {
    const setup = await beginTotpSetup(db, adminId);
    secret = setup.secret;
    const totp = new OTPAuth.TOTP({
      issuer: "PriceGames Admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    verifyAndEnableTotp(db, adminId, totp.generate());
    // Reset counter so codes work within the same 30s window for testing
    db.prepare("UPDATE admin_users SET totp_last_used_counter = NULL WHERE id = ?").run(adminId);
  });

  function generateValidCode(): string {
    return new OTPAuth.TOTP({
      issuer: "PriceGames Admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate();
  }

  it("returns true for a valid code", () => {
    expect(verifyTotpCode(db, adminId, generateValidCode())).toBe(true);
  });

  it("returns false for an invalid code", () => {
    expect(verifyTotpCode(db, adminId, "000000")).toBe(false);
  });

  it("rejects replayed code (same counter)", () => {
    const code = generateValidCode();
    expect(verifyTotpCode(db, adminId, code)).toBe(true);
    // Same code again should be rejected (replay protection)
    expect(verifyTotpCode(db, adminId, code)).toBe(false);
  });

  it("returns false when no secret is stored", () => {
    db.prepare("UPDATE admin_users SET totp_secret_encrypted = NULL WHERE id = ?").run(adminId);
    expect(verifyTotpCode(db, adminId, "123456")).toBe(false);
  });
});

// ── verifyRecoveryCodeAndConsume ───────────────────────────────────────────

describe("verifyRecoveryCodeAndConsume", () => {
  let recoveryCodes: string[];

  beforeEach(async () => {
    const setup = await beginTotpSetup(db, adminId);
    const totp = new OTPAuth.TOTP({
      issuer: "PriceGames Admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(setup.secret),
    });
    const result = verifyAndEnableTotp(db, adminId, totp.generate());
    recoveryCodes = result.recoveryCodes;
  });

  it("consumes a valid recovery code", () => {
    expect(verifyRecoveryCodeAndConsume(db, adminId, recoveryCodes[0])).toBe(true);
    // Should not work again
    expect(verifyRecoveryCodeAndConsume(db, adminId, recoveryCodes[0])).toBe(false);
  });

  it("returns false for invalid code", () => {
    expect(verifyRecoveryCodeAndConsume(db, adminId, "XXXXXXXX")).toBe(false);
  });

  it("decrements remaining count", () => {
    verifyRecoveryCodeAndConsume(db, adminId, recoveryCodes[0]);
    const status = getTotpStatus(db, adminId);
    expect(status.recoveryCodesRemaining).toBe(9);
  });
});

// ── disableTotp ────────────────────────────────────────────────────────────

describe("disableTotp", () => {
  let secret: string;
  let recoveryCodes: string[];

  beforeEach(async () => {
    const setup = await beginTotpSetup(db, adminId);
    secret = setup.secret;
    const totp = new OTPAuth.TOTP({
      issuer: "PriceGames Admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const result = verifyAndEnableTotp(db, adminId, totp.generate());
    recoveryCodes = result.recoveryCodes;
    // Reset the counter so TOTP codes work again in the same 30s window
    db.prepare("UPDATE admin_users SET totp_last_used_counter = NULL WHERE id = ?").run(adminId);
  });

  function generateValidCode(): string {
    return new OTPAuth.TOTP({
      issuer: "PriceGames Admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate();
  }

  it("disables 2FA with valid password and TOTP code", () => {
    disableTotp(db, adminId, "testpassword123", generateValidCode());
    expect(isTotpEnabled(db, adminId)).toBe(false);
    const codes = db.prepare("SELECT COUNT(*) as cnt FROM admin_2fa_recovery_codes WHERE admin_user_id = ?").get(adminId) as { cnt: number };
    expect(codes.cnt).toBe(0);
  });

  it("disables 2FA with valid password and recovery code", () => {
    disableTotp(db, adminId, "testpassword123", recoveryCodes[0], true);
    expect(isTotpEnabled(db, adminId)).toBe(false);
  });

  it("throws on wrong password", () => {
    expect(() => disableTotp(db, adminId, "wrongpassword", generateValidCode())).toThrow("Invalid password");
    expect(isTotpEnabled(db, adminId)).toBe(true);
  });

  it("throws on wrong TOTP code", () => {
    expect(() => disableTotp(db, adminId, "testpassword123", "000000")).toThrow("Invalid verification code");
    expect(isTotpEnabled(db, adminId)).toBe(true);
  });

  it("throws on wrong recovery code", () => {
    expect(() => disableTotp(db, adminId, "testpassword123", "XXXXXXXX", true)).toThrow("Invalid recovery code");
    expect(isTotpEnabled(db, adminId)).toBe(true);
  });

  it("invalidates all sessions", () => {
    db.prepare("INSERT INTO admin_sessions (id, admin_user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)").run(
      "test-session", adminId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString(),
    );
    disableTotp(db, adminId, "testpassword123", generateValidCode());
    const sessions = db.prepare("SELECT COUNT(*) as cnt FROM admin_sessions WHERE admin_user_id = ?").get(adminId) as { cnt: number };
    expect(sessions.cnt).toBe(0);
  });

  it("logs audit event", () => {
    disableTotp(db, adminId, "testpassword123", generateValidCode());
    const events = db.prepare("SELECT event FROM admin_2fa_audit_log WHERE admin_user_id = ?").all(adminId) as { event: string }[];
    expect(events.some((e) => e.event === "2fa_disabled")).toBe(true);
  });
});

// ── regenerateRecoveryCodes ────────────────────────────────────────────────

describe("regenerateRecoveryCodes", () => {
  beforeEach(async () => {
    const setup = await beginTotpSetup(db, adminId);
    const totp = new OTPAuth.TOTP({
      issuer: "PriceGames Admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(setup.secret),
    });
    verifyAndEnableTotp(db, adminId, totp.generate());
  });

  it("generates new codes and invalidates old ones", () => {
    const result = regenerateRecoveryCodes(db, adminId, "testpassword123");
    expect(result.recoveryCodes).toHaveLength(10);

    // Old codes should all be gone (fresh set)
    const rows = db.prepare("SELECT COUNT(*) as cnt FROM admin_2fa_recovery_codes WHERE admin_user_id = ? AND is_used = 0").get(adminId) as { cnt: number };
    expect(rows.cnt).toBe(10);
  });

  it("throws on wrong password", () => {
    expect(() => regenerateRecoveryCodes(db, adminId, "wrong")).toThrow("Invalid password");
  });

  it("throws if 2FA is not enabled", () => {
    db.prepare("UPDATE admin_users SET totp_enabled = 0 WHERE id = ?").run(adminId);
    expect(() => regenerateRecoveryCodes(db, adminId, "testpassword123")).toThrow("2FA is not enabled");
  });
});

// ── Pending token ──────────────────────────────────────────────────────────

describe("createPendingTotpToken / validateAndConsumePendingToken", () => {
  it("creates and validates a token", () => {
    const token = createPendingTotpToken(db, adminId, "127.0.0.1", "test-agent");
    expect(token).toHaveLength(64);

    const result = validateAndConsumePendingToken(db, token);
    expect(result).not.toBeNull();
    expect(result!.adminUserId).toBe(adminId);
    expect(result!.ip).toBe("127.0.0.1");
    expect(result!.userAgent).toBe("test-agent");
  });

  it("consumes token on first use (one-time)", () => {
    const token = createPendingTotpToken(db, adminId);
    expect(validateAndConsumePendingToken(db, token)).not.toBeNull();
    expect(validateAndConsumePendingToken(db, token)).toBeNull();
  });

  it("rejects expired token", () => {
    const token = createPendingTotpToken(db, adminId);
    // Set expiry to past
    db.prepare("UPDATE admin_2fa_pending SET expires_at = ? WHERE admin_user_id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      adminId,
    );
    expect(validateAndConsumePendingToken(db, token)).toBeNull();
  });

  it("rejects unknown token", () => {
    expect(validateAndConsumePendingToken(db, "a".repeat(64))).toBeNull();
  });
});

// ── cleanupExpiredPendingTokens ────────────────────────────────────────────

describe("cleanupExpiredPendingTokens", () => {
  it("deletes expired tokens", () => {
    createPendingTotpToken(db, adminId);
    db.prepare("UPDATE admin_2fa_pending SET expires_at = ?").run(
      new Date(Date.now() - 1000).toISOString(),
    );
    const deleted = cleanupExpiredPendingTokens(db);
    expect(deleted).toBe(1);
  });

  it("cleans up orphaned unverified TOTP setups", async () => {
    await beginTotpSetup(db, adminId);
    // Set updated_at to >10 minutes ago
    db.prepare("UPDATE admin_users SET updated_at = ? WHERE id = ?").run(
      new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      adminId,
    );
    cleanupExpiredPendingTokens(db);
    const row = db.prepare("SELECT totp_secret_encrypted FROM admin_users WHERE id = ?").get(adminId) as Record<string, unknown>;
    expect(row.totp_secret_encrypted).toBeNull();
  });
});

// ── logAuditEvent ──────────────────────────────────────────────────────────

describe("logAuditEvent", () => {
  it("inserts an audit event", () => {
    logAuditEvent(db, adminId, "test_event", "1.2.3.4", "test-ua");
    const rows = db.prepare("SELECT * FROM admin_2fa_audit_log WHERE admin_user_id = ?").all(adminId) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe("test_event");
    expect(rows[0].ip_address).toBe("1.2.3.4");
    expect(rows[0].user_agent).toBe("test-ua");
  });
});
