/**
 * Admin TOTP two-factor authentication service.
 *
 * Handles TOTP setup/verification, recovery code generation/validation,
 * pending 2FA login tokens, and audit logging. TOTP secrets are encrypted
 * at rest with AES-256-GCM using a server-side key.
 */

import crypto from "crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import type { Database as DatabaseType } from "better-sqlite3";
import { config } from "../config";

// ── Constants ──────────────────────────────────────────────────────────────

/** Characters for recovery codes — uppercase alphanumeric minus ambiguous chars (0, O, 1, I, L). */
const RECOVERY_CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const RECOVERY_CODE_LENGTH = 8;
const TOTP_ISSUER = "PriceGames Admin";
const ENCRYPTION_VERSION = "v1";

// ── Encryption helpers ─────────────────────────────────────────────────────

/**
 * Get the AES-256-GCM encryption key from config.
 * @throws If the key is not a valid 32-byte hex string.
 */
function getEncryptionKey(): Buffer {
  const keyHex = config.admin2faEncryptionKey;
  if (!keyHex) {
    throw new Error("ADMIN_2FA_ENCRYPTION_KEY is not configured");
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error(
      "ADMIN_2FA_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)",
    );
  }
  return key;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * @returns Ciphertext in format `v1:<iv_hex>:<tag_hex>:<ciphertext_hex>`.
 */
function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTION_VERSION}:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a ciphertext string encrypted with AES-256-GCM.
 * @throws If the ciphertext format is invalid or decryption fails.
 */
function decryptSecret(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) {
    throw new Error("Invalid encrypted secret format");
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(parts[1], "hex");
  const tag = Buffer.from(parts[2], "hex");
  const ciphertext = Buffer.from(parts[3], "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

// ── Recovery code helpers ──────────────────────────────────────────────────

/**
 * Generate cryptographically random recovery codes.
 * @param count - Number of codes to generate.
 * @returns Array of plaintext recovery codes.
 */
function generateRecoveryCodes(count: number): string[] {
  const charCount = RECOVERY_CODE_CHARS.length; // 31
  // Rejection sampling threshold to eliminate modulo bias
  const maxUnbiased = Math.floor(256 / charCount) * charCount; // 248
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = "";
    while (code.length < RECOVERY_CODE_LENGTH) {
      const byte = crypto.randomBytes(1)[0];
      if (byte < maxUnbiased) {
        code += RECOVERY_CODE_CHARS[byte % charCount];
      }
    }
    codes.push(code);
  }
  return codes;
}

/**
 * Hash a recovery code with a random salt using SHA-256.
 * @returns The hex hash and hex salt.
 */
function hashRecoveryCode(code: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .createHash("sha256")
    .update(salt + code.toUpperCase().replace(/\s/g, ""))
    .digest("hex");
  return { hash, salt };
}

/**
 * Verify a recovery code against a stored hash using timing-safe comparison.
 */
function verifyRecoveryCode(
  code: string,
  storedHash: string,
  salt: string,
): boolean {
  const candidateHash = crypto
    .createHash("sha256")
    .update(salt + code.toUpperCase().replace(/\s/g, ""))
    .digest();
  const storedBuf = Buffer.from(storedHash, "hex");
  if (candidateHash.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(candidateHash, storedBuf);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Check whether TOTP 2FA is enabled for an admin user.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @returns true if 2FA is enabled.
 */
export function isTotpEnabled(
  db: DatabaseType,
  adminUserId: string,
): boolean {
  const row = db
    .prepare("SELECT totp_enabled, totp_secret_encrypted FROM admin_users WHERE id = ?")
    .get(adminUserId) as { totp_enabled: number; totp_secret_encrypted: string | null } | undefined;
  // Both the flag and an encrypted secret must be present
  return row?.totp_enabled === 1 && row?.totp_secret_encrypted !== null;
}

/**
 * Get the 2FA status for an admin user.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @returns Status object with enabled state, date, and remaining recovery codes.
 */
export function getTotpStatus(
  db: DatabaseType,
  adminUserId: string,
): { enabled: boolean; enabledAt: string | null; recoveryCodesRemaining: number } {
  const user = db
    .prepare("SELECT totp_enabled, totp_verified_at FROM admin_users WHERE id = ?")
    .get(adminUserId) as { totp_enabled: number; totp_verified_at: string | null } | undefined;

  const remaining = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM admin_2fa_recovery_codes WHERE admin_user_id = ? AND is_used = 0",
    )
    .get(adminUserId) as { cnt: number };

  return {
    enabled: user?.totp_enabled === 1,
    enabledAt: user?.totp_verified_at ?? null,
    recoveryCodesRemaining: remaining.cnt,
  };
}

/**
 * Begin TOTP setup — generate a secret, encrypt and store it, return QR + manual key.
 *
 * Does NOT enable 2FA yet; the admin must verify a code first.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @returns Object with secret (base32), otpauth URI, and QR code data URL.
 */
export async function beginTotpSetup(
  db: DatabaseType,
  adminUserId: string,
): Promise<{ secret: string; otpauthUri: string; qrCodeDataUrl: string }> {
  const user = db
    .prepare("SELECT username, totp_enabled, totp_secret_encrypted FROM admin_users WHERE id = ?")
    .get(adminUserId) as { username: string; totp_enabled: number; totp_secret_encrypted: string | null } | undefined;
  if (!user) throw new Error("Admin user not found");
  if (user.totp_enabled === 1 && user.totp_secret_encrypted !== null) {
    throw new Error("2FA is already enabled — disable it first");
  }

  // Reuse existing pending secret if setup was started but not yet verified
  let secret: OTPAuth.Secret;
  let isReuse = false;
  if (user.totp_secret_encrypted && user.totp_enabled === 0) {
    const existingBase32 = decryptSecret(user.totp_secret_encrypted);
    secret = OTPAuth.Secret.fromBase32(existingBase32);
    isReuse = true;
  } else {
    secret = new OTPAuth.Secret({ size: 20 });
    const encrypted = encryptSecret(secret.base32);
    db.prepare(
      "UPDATE admin_users SET totp_secret_encrypted = ?, totp_enabled = 0, totp_verified_at = NULL, updated_at = ? WHERE id = ?",
    ).run(encrypted, new Date().toISOString(), adminUserId);
  }

  // SHA-1 is mandated by RFC 6238 and required for authenticator app
  // compatibility (Google Authenticator, Authy). Not a weakness in this
  // context — TOTP threat model is OTP prediction, not hash collision.
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: user.username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });

  const otpauthUri = totp.toString();
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);

  logAuditEvent(db, adminUserId, isReuse ? "2fa_setup_qr_reopened" : "2fa_setup_started");

  return { secret: secret.base32, otpauthUri, qrCodeDataUrl };
}

/**
 * Verify a TOTP code to complete 2FA setup. Enables 2FA and generates recovery codes.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @param code - 6-digit TOTP code from the authenticator app.
 * @param ip - Optional IP address for audit.
 * @param userAgent - Optional user agent for audit.
 * @returns Plaintext recovery codes (shown once to the user).
 * @throws If the code is invalid or no pending secret exists.
 */
export function verifyAndEnableTotp(
  db: DatabaseType,
  adminUserId: string,
  code: string,
  ip?: string,
  userAgent?: string,
): { recoveryCodes: string[] } {
  const row = db
    .prepare("SELECT totp_secret_encrypted, totp_enabled FROM admin_users WHERE id = ?")
    .get(adminUserId) as { totp_secret_encrypted: string | null; totp_enabled: number } | undefined;

  if (!row?.totp_secret_encrypted) {
    throw new Error("No pending 2FA setup found");
  }
  if (row.totp_enabled === 1) {
    throw new Error("2FA is already enabled");
  }

  const secretBase32 = decryptSecret(row.totp_secret_encrypted);
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

  const delta = totp.validate({ token: code.trim(), window: config.admin2faTotpWindow });
  if (delta === null) {
    logAuditEvent(db, adminUserId, "2fa_setup_verify_failed", ip, userAgent);
    throw new Error("Invalid verification code");
  }

  // Enable 2FA
  const now = new Date().toISOString();
  // Store the counter to prevent replay
  const counter = Math.floor(Date.now() / 1000 / 30) + delta;
  db.prepare(
    "UPDATE admin_users SET totp_enabled = 1, totp_verified_at = ?, totp_last_used_counter = ?, updated_at = ? WHERE id = ?",
  ).run(now, counter, now, adminUserId);

  // Generate and store recovery codes
  const codes = generateRecoveryCodes(config.admin2faRecoveryCodeCount);
  // Delete any existing codes first
  db.prepare("DELETE FROM admin_2fa_recovery_codes WHERE admin_user_id = ?").run(adminUserId);

  const insertStmt = db.prepare(
    "INSERT INTO admin_2fa_recovery_codes (admin_user_id, code_hash, salt, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const plainCode of codes) {
    const { hash, salt } = hashRecoveryCode(plainCode);
    insertStmt.run(adminUserId, hash, salt, now);
  }

  logAuditEvent(db, adminUserId, "2fa_enabled", ip, userAgent);

  return { recoveryCodes: codes };
}

/**
 * Verify a TOTP code during login.
 *
 * Includes replay protection — rejects codes with a counter <= the last used counter.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @param code - 6-digit TOTP code.
 * @returns true if the code is valid.
 */
export function verifyTotpCode(
  db: DatabaseType,
  adminUserId: string,
  code: string,
): boolean {
  const row = db
    .prepare("SELECT totp_secret_encrypted, totp_last_used_counter FROM admin_users WHERE id = ?")
    .get(adminUserId) as {
      totp_secret_encrypted: string | null;
      totp_last_used_counter: number | null;
    } | undefined;

  if (!row?.totp_secret_encrypted) return false;

  const secretBase32 = decryptSecret(row.totp_secret_encrypted);
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

  const delta = totp.validate({ token: code.trim(), window: config.admin2faTotpWindow });
  if (delta === null) return false;

  // Replay protection: reject if counter <= last used
  const counter = Math.floor(Date.now() / 1000 / 30) + delta;
  if (row.totp_last_used_counter !== null && counter <= row.totp_last_used_counter) {
    return false;
  }

  // Update last used counter
  db.prepare("UPDATE admin_users SET totp_last_used_counter = ? WHERE id = ?").run(
    counter,
    adminUserId,
  );

  return true;
}

/**
 * Verify and consume a recovery code.
 *
 * Marks the code as used if valid.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @param code - Recovery code (8-char alphanumeric).
 * @returns true if the code was valid and consumed.
 */
export function verifyRecoveryCodeAndConsume(
  db: DatabaseType,
  adminUserId: string,
  code: string,
): boolean {
  const rows = db
    .prepare(
      "SELECT id, code_hash, salt FROM admin_2fa_recovery_codes WHERE admin_user_id = ? AND is_used = 0",
    )
    .all(adminUserId) as { id: number; code_hash: string; salt: string }[];

  for (const row of rows) {
    if (verifyRecoveryCode(code, row.code_hash, row.salt)) {
      db.prepare(
        "UPDATE admin_2fa_recovery_codes SET is_used = 1, used_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), row.id);

      logAuditEvent(db, adminUserId, "recovery_code_used");
      return true;
    }
  }

  return false;
}

/**
 * Disable TOTP 2FA for an admin user.
 *
 * Requires both the current password and a valid TOTP/recovery code for security.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @param password - Current password for re-authentication.
 * @param code - Current TOTP code or recovery code.
 * @param isRecoveryCode - Whether the code is a recovery code.
 * @param ip - Optional IP address for audit.
 * @param userAgent - Optional user agent for audit.
 * @throws If the password is invalid or the TOTP/recovery code is invalid.
 */
export function disableTotp(
  db: DatabaseType,
  adminUserId: string,
  password: string,
  code: string,
  isRecoveryCode: boolean = false,
  ip?: string,
  userAgent?: string,
): void {
  // Verify password
  const row = db
    .prepare("SELECT password_hash FROM admin_users WHERE id = ?")
    .get(adminUserId) as { password_hash: string } | undefined;
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    throw new Error("Invalid password");
  }

  // Verify TOTP or recovery code
  if (isRecoveryCode) {
    if (!verifyRecoveryCodeAndConsume(db, adminUserId, code)) {
      throw new Error("Invalid recovery code");
    }
  } else {
    if (!verifyTotpCode(db, adminUserId, code)) {
      throw new Error("Invalid verification code");
    }
  }

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE admin_users SET totp_secret_encrypted = NULL, totp_enabled = 0, totp_verified_at = NULL, totp_last_used_counter = NULL, updated_at = ? WHERE id = ?",
  ).run(now, adminUserId);

  // Delete all recovery codes
  db.prepare("DELETE FROM admin_2fa_recovery_codes WHERE admin_user_id = ?").run(adminUserId);

  // Invalidate all sessions for this user
  db.prepare("DELETE FROM admin_sessions WHERE admin_user_id = ?").run(adminUserId);

  logAuditEvent(db, adminUserId, "2fa_disabled", ip, userAgent);
}

/**
 * Regenerate recovery codes. Requires password re-verification.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @param password - Current password for re-authentication.
 * @param ip - Optional IP address for audit.
 * @param userAgent - Optional user agent for audit.
 * @returns New plaintext recovery codes.
 * @throws If the password is invalid or 2FA is not enabled.
 */
export function regenerateRecoveryCodes(
  db: DatabaseType,
  adminUserId: string,
  password: string,
  ip?: string,
  userAgent?: string,
): { recoveryCodes: string[] } {
  const row = db
    .prepare("SELECT password_hash, totp_enabled FROM admin_users WHERE id = ?")
    .get(adminUserId) as { password_hash: string; totp_enabled: number } | undefined;

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    throw new Error("Invalid password");
  }
  if (row.totp_enabled !== 1) {
    throw new Error("2FA is not enabled");
  }

  const now = new Date().toISOString();
  db.prepare("DELETE FROM admin_2fa_recovery_codes WHERE admin_user_id = ?").run(adminUserId);

  const codes = generateRecoveryCodes(config.admin2faRecoveryCodeCount);
  const insertStmt = db.prepare(
    "INSERT INTO admin_2fa_recovery_codes (admin_user_id, code_hash, salt, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const plainCode of codes) {
    const { hash, salt } = hashRecoveryCode(plainCode);
    insertStmt.run(adminUserId, hash, salt, now);
  }

  logAuditEvent(db, adminUserId, "recovery_codes_regenerated", ip, userAgent);

  return { recoveryCodes: codes };
}

/**
 * Create a short-lived pending 2FA login token.
 *
 * The raw token is returned to the client; the SHA-256 hash is stored in the DB.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @param ip - Optional IP address.
 * @param userAgent - Optional user agent.
 * @returns The raw token string (64 hex chars).
 */
export function createPendingTotpToken(
  db: DatabaseType,
  adminUserId: string,
  ip?: string,
  userAgent?: string,
): string {
  const id = uuidv4();
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + config.admin2faPendingTokenDurationMs).toISOString();

  db.prepare(
    "INSERT INTO admin_2fa_pending (id, token_hash, admin_user_id, created_at, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, tokenHash, adminUserId, now, expiresAt, ip ?? null, userAgent ?? null);

  return rawToken;
}

/**
 * Validate and consume a pending 2FA login token.
 *
 * The token is deleted after use (one-time). Expired tokens are rejected.
 *
 * @param db - Database instance.
 * @param rawToken - The raw token from the client.
 * @returns Admin user ID and metadata if valid, null otherwise.
 */
export function validateAndConsumePendingToken(
  db: DatabaseType,
  rawToken: string,
): { adminUserId: string; ip: string | null; userAgent: string | null } | null {
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const row = db
    .prepare("SELECT id, admin_user_id, expires_at, ip_address, user_agent FROM admin_2fa_pending WHERE token_hash = ?")
    .get(tokenHash) as {
      id: string;
      admin_user_id: string;
      expires_at: string;
      ip_address: string | null;
      user_agent: string | null;
    } | undefined;

  if (!row) return null;

  // Always delete — one-time use
  db.prepare("DELETE FROM admin_2fa_pending WHERE id = ?").run(row.id);

  // Check expiry
  if (new Date(row.expires_at).getTime() < Date.now()) {
    logAuditEvent(db, row.admin_user_id, "2fa_pending_token_expired");
    return null;
  }

  return {
    adminUserId: row.admin_user_id,
    ip: row.ip_address,
    userAgent: row.user_agent,
  };
}

/**
 * Clean up expired pending 2FA tokens and orphaned unverified TOTP setups.
 *
 * @param db - Database instance.
 * @returns Number of rows deleted.
 */
export function cleanupExpiredPendingTokens(db: DatabaseType): number {
  const now = new Date().toISOString();
  const result = db.prepare("DELETE FROM admin_2fa_pending WHERE expires_at < ?").run(now);

  // Clean up orphaned TOTP setups older than 10 minutes that were never verified
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE admin_users SET totp_secret_encrypted = NULL WHERE totp_enabled = 0 AND totp_secret_encrypted IS NOT NULL AND updated_at < ?",
  ).run(tenMinAgo);

  return result.changes;
}

/**
 * Log a 2FA audit event.
 *
 * @param db - Database instance.
 * @param adminUserId - Admin user ID.
 * @param event - Event type (e.g., "2fa_enabled", "2fa_disabled", "recovery_code_used").
 * @param ip - Optional IP address.
 * @param userAgent - Optional user agent.
 */
export function logAuditEvent(
  db: DatabaseType,
  adminUserId: string,
  event: string,
  ip?: string,
  userAgent?: string,
): void {
  db.prepare(
    "INSERT INTO admin_2fa_audit_log (admin_user_id, event, ip_address, user_agent, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(adminUserId, event, ip ?? null, userAgent ?? null, new Date().toISOString());
}

// Export internals for testing
export const _testing = {
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
};
