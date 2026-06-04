import { useState, useEffect, type FormEvent } from "react";
import { useAdminAuth } from "../../context/AdminAuthContext";
import {
  admin2faGetStatus,
  admin2faBeginSetup,
  admin2faVerifySetup,
  admin2faDisable,
  admin2faRegenerateCodes,
} from "../../api/adminClient";
import type { Admin2faStatusResponse } from "@price-game/shared";

type SetupStep = "idle" | "qr" | "recovery-display";

/**
 * Admin 2FA settings page. Allows admins to enable, disable, and manage
 * two-factor authentication for their account.
 */
export default function Admin2faSettingsPage() {
  const { user, refreshUser } = useAdminAuth();
  const [status, setStatus] = useState<Admin2faStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Setup state
  const [setupStep, setSetupStep] = useState<SetupStep>("idle");
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [manualSecret, setManualSecret] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [codesAcknowledged, setCodesAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Disable state
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [disableUseRecovery, setDisableUseRecovery] = useState(false);

  // Regenerate state
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [regenPassword, setRegenPassword] = useState("");

  useEffect(() => {
    admin2faGetStatus()
      .then(setStatus)
      .catch(() => setError("Failed to load 2FA status"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="admin-page"><div className="admin-loading">Loading...</div></div>;
  }

  const isEnabled = status?.enabled ?? false;

  // ── Begin Setup ──────────────────────────────────────────────────────
  async function handleBeginSetup() {
    setError(null);
    setSubmitting(true);
    try {
      const result = await admin2faBeginSetup();
      setQrCodeUrl(result.qrCodeDataUrl);
      setManualSecret(result.secret);
      setSetupStep("qr");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Verify Setup ─────────────────────────────────────────────────────
  async function handleVerifySetup(e: FormEvent) {
    e.preventDefault();
    if (!verifyCode.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await admin2faVerifySetup(verifyCode.trim());
      setRecoveryCodes(result.recoveryCodes);
      setSetupStep("recovery-display");
      // Refresh status
      const newStatus = await admin2faGetStatus();
      setStatus(newStatus);
      await refreshUser();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Disable 2FA ──────────────────────────────────────────────────────
  async function handleDisable(e: FormEvent) {
    e.preventDefault();
    if (!disablePassword || !disableCode) return;
    setError(null);
    setSubmitting(true);
    try {
      await admin2faDisable(disablePassword, disableCode, disableUseRecovery);
      setShowDisable(false);
      setDisablePassword("");
      setDisableCode("");
      const newStatus = await admin2faGetStatus();
      setStatus(newStatus);
      await refreshUser();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Disable failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Regenerate Codes ─────────────────────────────────────────────────
  async function handleRegenerate(e: FormEvent) {
    e.preventDefault();
    if (!regenPassword) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await admin2faRegenerateCodes(regenPassword);
      setRecoveryCodes(result.recoveryCodes);
      setCodesAcknowledged(false);
      setShowRegenerate(false);
      setRegenPassword("");
      setSetupStep("recovery-display");
      const newStatus = await admin2faGetStatus();
      setStatus(newStatus);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Regeneration failed");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Copy recovery codes ──────────────────────────────────────────────
  function copyRecoveryCodes() {
    navigator.clipboard.writeText(recoveryCodes.join("\n"));
  }

  function downloadRecoveryCodes() {
    const blob = new Blob([recoveryCodes.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "price-games-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="admin-page" data-testid="admin-2fa-settings">
      <h1>Security Settings</h1>

      {error && <div className="admin-error">{error}</div>}

      {/* Recovery codes display (shown after enable or regenerate) */}
      {setupStep === "recovery-display" && (
        <div className="admin-card" data-testid="admin-2fa-recovery-display">
          <h2>Recovery Codes</h2>
          <p className="admin-warning">
            Save these recovery codes in a secure location. Each code can only be used once.
            You will not be able to see them again.
          </p>
          <div className="admin-recovery-codes" data-testid="admin-2fa-codes-list">
            {recoveryCodes.map((code, i) => (
              <code key={i} className="admin-recovery-code">{code}</code>
            ))}
          </div>
          <div className="admin-actions">
            <button type="button" onClick={copyRecoveryCodes} className="admin-btn-secondary">
              Copy All
            </button>
            <button type="button" onClick={downloadRecoveryCodes} className="admin-btn-secondary">
              Download
            </button>
          </div>
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={codesAcknowledged}
              onChange={(e) => setCodesAcknowledged(e.target.checked)}
              data-testid="admin-2fa-codes-ack"
            />
            I have saved my recovery codes
          </label>
          <button
            type="button"
            onClick={() => { setSetupStep("idle"); setRecoveryCodes([]); }}
            disabled={!codesAcknowledged}
            className="admin-btn"
            data-testid="admin-2fa-codes-done"
          >
            Done
          </button>
        </div>
      )}

      {/* QR code setup step */}
      {setupStep === "qr" && (
        <div className="admin-card" data-testid="admin-2fa-setup-qr">
          <h2>Set Up Two-Factor Authentication</h2>
          <p>Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.):</p>
          <div className="admin-qr-container">
            <img src={qrCodeUrl} alt="TOTP QR Code" className="admin-qr-code" />
          </div>
          <details className="admin-manual-entry">
            <summary>Can't scan? Enter this key manually:</summary>
            <code className="admin-secret-key" data-testid="admin-2fa-manual-key">{manualSecret}</code>
          </details>
          <form onSubmit={handleVerifySetup} className="admin-2fa-verify-form">
            <label>Enter the 6-digit code from your app to verify:</label>
            <input
              type="text"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              placeholder="000000"
              autoFocus
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              data-testid="admin-2fa-setup-code"
              disabled={submitting}
            />
            <button type="submit" disabled={!verifyCode.trim() || submitting} className="admin-btn">
              {submitting ? "Verifying..." : "Verify & Enable"}
            </button>
            <button type="button" onClick={() => setSetupStep("idle")} className="admin-link-btn">
              Cancel
            </button>
          </form>
        </div>
      )}

      {/* Main status view */}
      {setupStep === "idle" && (
        <>
          <div className="admin-card">
            <h2>Two-Factor Authentication</h2>
            {isEnabled ? (
              <>
                <p className="admin-status admin-status-enabled" data-testid="admin-2fa-status">
                  2FA is enabled
                  {status?.enabledAt && <span className="admin-status-date"> (since {new Date(status.enabledAt).toLocaleDateString()})</span>}
                </p>
                <p>Recovery codes remaining: <strong>{status?.recoveryCodesRemaining ?? 0}</strong></p>

                <div className="admin-actions">
                  <button
                    type="button"
                    onClick={() => setShowRegenerate(true)}
                    className="admin-btn-secondary"
                    data-testid="admin-2fa-regenerate-btn"
                  >
                    Regenerate Recovery Codes
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDisable(true)}
                    className="admin-btn-danger"
                    data-testid="admin-2fa-disable-btn"
                  >
                    Disable 2FA
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="admin-status admin-status-disabled" data-testid="admin-2fa-status">
                  2FA is not enabled
                </p>
                <p className="admin-warning">
                  Two-factor authentication is required for all admin accounts.
                  Please set up 2FA to continue using the admin panel.
                </p>
                <button
                  type="button"
                  onClick={handleBeginSetup}
                  disabled={submitting}
                  className="admin-btn"
                  data-testid="admin-2fa-enable-btn"
                >
                  {submitting ? "Setting up..." : "Enable Two-Factor Authentication"}
                </button>
              </>
            )}
          </div>

          {/* Disable modal */}
          {showDisable && (
            <div className="admin-card admin-card-warning" data-testid="admin-2fa-disable-form">
              <h3>Disable Two-Factor Authentication</h3>
              <p className="admin-warning">
                Warning: Disabling 2FA will require you to re-enroll immediately, as 2FA is mandatory for all admin accounts.
              </p>
              <form onSubmit={handleDisable}>
                <input
                  type="password"
                  placeholder="Current password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={submitting}
                />
                <input
                  type="text"
                  placeholder={disableUseRecovery ? "Recovery code" : "6-digit TOTP code"}
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  disabled={submitting}
                />
                <label className="admin-checkbox">
                  <input
                    type="checkbox"
                    checked={disableUseRecovery}
                    onChange={(e) => { setDisableUseRecovery(e.target.checked); setDisableCode(""); }}
                  />
                  Use recovery code
                </label>
                <div className="admin-actions">
                  <button type="submit" disabled={!disablePassword || !disableCode || submitting} className="admin-btn-danger">
                    {submitting ? "Disabling..." : "Disable 2FA"}
                  </button>
                  <button type="button" onClick={() => { setShowDisable(false); setDisablePassword(""); setDisableCode(""); }} className="admin-link-btn">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Regenerate modal */}
          {showRegenerate && (
            <div className="admin-card" data-testid="admin-2fa-regenerate-form">
              <h3>Regenerate Recovery Codes</h3>
              <p>This will invalidate all existing recovery codes and generate new ones.</p>
              <form onSubmit={handleRegenerate}>
                <input
                  type="password"
                  placeholder="Current password"
                  value={regenPassword}
                  onChange={(e) => setRegenPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={submitting}
                />
                <div className="admin-actions">
                  <button type="submit" disabled={!regenPassword || submitting} className="admin-btn">
                    {submitting ? "Regenerating..." : "Regenerate Codes"}
                  </button>
                  <button type="button" onClick={() => { setShowRegenerate(false); setRegenPassword(""); }} className="admin-link-btn">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
