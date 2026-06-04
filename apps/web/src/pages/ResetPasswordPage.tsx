import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { userResetPassword } from "../api/userClient";

/**
 * Reset password form — accepts a new password and submits with the token from the URL.
 * Linked from the password reset email.
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 10) {
      setError("Password must be at least 10 characters");
      return;
    }

    if (!token) {
      setError("Invalid reset link — no token provided");
      return;
    }

    setLoading(true);
    try {
      await userResetPassword(token, password);
      setSuccess(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Password reset failed");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="app">
        <div className="auth-page">
          <div className="auth-page-card">
            <h1 className="auth-form-title">Reset Password</h1>
            <p className="auth-error">Invalid reset link — no token provided.</p>
            <button
              className="btn btn-primary auth-submit"
              onClick={() => navigate("/")}
            >
              Back to Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="auth-page">
        <div className="auth-page-card">
          <h1 className="auth-form-title">Reset Password</h1>

          {success ? (
            <>
              <p className="auth-page-text auth-page-success">
                Your password has been reset successfully. You can now log in with your new password.
              </p>
              <button
                className="btn btn-primary auth-submit"
                onClick={() => navigate("/")}
              >
                Go to Login
              </button>
            </>
          ) : (
            <form className="auth-form" onSubmit={handleSubmit}>
              {error && <p className="auth-error">{error}</p>}

              <div className="auth-field">
                <label htmlFor="reset-password">New Password</label>
                <input
                  id="reset-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter new password (min 10 characters)"
                  autoComplete="new-password"
                  disabled={loading}
                  autoFocus
                />
              </div>

              <div className="auth-field">
                <label htmlFor="reset-confirm">Confirm Password</label>
                <input
                  id="reset-confirm"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  disabled={loading}
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary auth-submit"
                disabled={loading || !password || !confirmPassword}
              >
                {loading ? "Resetting..." : "Reset Password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
