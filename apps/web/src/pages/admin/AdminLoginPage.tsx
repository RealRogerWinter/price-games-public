import { useState, type FormEvent } from "react";
import { useAdminAuth } from "../../context/AdminAuthContext";

/**
 * Admin login form page. Two-step flow:
 * 1. Username/password (always shown first)
 * 2. TOTP verification (shown if 2FA is enabled for the account)
 */
export default function AdminLoginPage() {
  const { login, verify2fa, cancelTwoFactor, error, loading: authLoading, isAuthenticated, pendingTwoFactor } = useAdminAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  if (isAuthenticated) {
    return null;
  }

  const isLoading = submitting || authLoading;

  // ── Step 2: TOTP Verification ────────────────────────────────────────
  if (pendingTwoFactor) {
    const canSubmit2fa = totpCode.trim().length > 0 && !isLoading;

    async function handleVerify(e: FormEvent) {
      e.preventDefault();
      if (!canSubmit2fa) return;
      setSubmitting(true);
      try {
        await verify2fa(totpCode.trim(), useRecoveryCode);
      } catch {
        // Error is surfaced via context
      } finally {
        setSubmitting(false);
      }
    }

    function handleBack() {
      setTotpCode("");
      setUseRecoveryCode(false);
      cancelTwoFactor();
    }

    return (
      <div className="admin-login" data-testid="admin-login-page">
        <h1>Two-Factor Authentication</h1>

        {error && (
          <div className="admin-error" data-testid="admin-login-error">
            {error}
          </div>
        )}

        <p className="admin-2fa-prompt">
          {useRecoveryCode
            ? "Enter one of your recovery codes."
            : "Enter the 6-digit code from your authenticator app."}
        </p>

        <form onSubmit={handleVerify} data-testid="admin-2fa-form">
          <input
            type="text"
            placeholder={useRecoveryCode ? "Recovery code" : "6-digit code"}
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            autoComplete="one-time-code"
            autoFocus
            data-testid="admin-2fa-code"
            disabled={isLoading}
            inputMode={useRecoveryCode ? "text" : "numeric"}
            pattern={useRecoveryCode ? undefined : "[0-9]*"}
            maxLength={useRecoveryCode ? 12 : 6}
          />
          <button type="submit" disabled={!canSubmit2fa} data-testid="admin-2fa-submit">
            {isLoading ? "Verifying..." : "Verify"}
          </button>
        </form>

        <div className="admin-2fa-actions">
          <button
            type="button"
            className="admin-link-btn"
            onClick={() => {
              setUseRecoveryCode(!useRecoveryCode);
              setTotpCode("");
            }}
            data-testid="admin-2fa-toggle-recovery"
          >
            {useRecoveryCode ? "Use authenticator code instead" : "Use a recovery code"}
          </button>
          <button
            type="button"
            className="admin-link-btn"
            onClick={handleBack}
            data-testid="admin-2fa-back"
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  // ── Step 1: Username / Password ──────────────────────────────────────
  const canSubmit = username.trim().length > 0 && password.length > 0 && !isLoading;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch {
      // Error is surfaced via context
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="admin-login" data-testid="admin-login-page">
      <h1>Admin Login</h1>

      {error && (
        <div className="admin-error" data-testid="admin-login-error">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} data-testid="admin-login-form">
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          data-testid="admin-login-username"
          disabled={isLoading}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          data-testid="admin-login-password"
          disabled={isLoading}
        />
        <button type="submit" disabled={!canSubmit} data-testid="admin-login-submit">
          {isLoading ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </div>
  );
}
