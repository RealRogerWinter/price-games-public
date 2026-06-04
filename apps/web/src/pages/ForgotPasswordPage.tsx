import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { userForgotPassword } from "../api/userClient";

/**
 * Forgot password form — accepts an email and requests a password reset link.
 * Always shows success to prevent email enumeration.
 */
export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await userForgotPassword(email.trim());
      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <div className="auth-page">
        <div className="auth-page-card">
          <h1 className="auth-form-title">Reset Password</h1>

          {submitted ? (
            <>
              <p className="auth-page-text auth-page-success">
                If an account exists with that email, we've sent a password reset link. Check your inbox.
              </p>
              <button
                className="btn btn-primary auth-submit"
                onClick={() => navigate("/")}
              >
                Back to Home
              </button>
            </>
          ) : (
            <form className="auth-form" onSubmit={handleSubmit}>
              <p className="auth-page-text">
                Enter your email address and we'll send you a link to reset your password.
              </p>

              {error && <p className="auth-error">{error}</p>}

              <div className="auth-field">
                <label htmlFor="forgot-email">Email</label>
                <input
                  id="forgot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  autoComplete="email"
                  disabled={loading}
                  autoFocus
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary auth-submit"
                disabled={loading || !email.trim()}
              >
                {loading ? "Sending..." : "Send Reset Link"}
              </button>

              <p className="auth-switch">
                <button type="button" className="btn-link" onClick={() => navigate("/")}>
                  Back to Home
                </button>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
