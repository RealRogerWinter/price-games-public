import { useState } from "react";
import { useUserAuth } from "../../context/UserAuthContext";
import OAuthButtons from "./OAuthButtons";

interface LoginFormProps {
  onSwitchToRegister: () => void;
  onForgotPassword?: () => void;
}

/**
 * Login form with email/username + password fields.
 * Displays server errors and a link to switch to the register form.
 * @param onSwitchToRegister - Callback to switch to the register view.
 * @param onForgotPassword - Callback to navigate to forgot password flow.
 */
export default function LoginForm({ onSwitchToRegister, onForgotPassword }: LoginFormProps) {
  const { login, oauthProviders } = useUserAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  // Default unchecked — classic opt-in "remember me" UX. When unchecked,
  // the server issues a browser-session cookie; when checked, the cookie
  // persists for the full session duration.
  const [stayLoggedIn, setStayLoggedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim() || !password) return;
    setLoading(true);
    setError(null);
    try {
      await login(identifier.trim(), password, stayLoggedIn);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Login failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h2 className="auth-form-title">Log In</h2>

      {error && <p className="auth-error">{error}</p>}

      <div className="auth-field">
        <label htmlFor="login-identifier">Email or Username</label>
        <input
          id="login-identifier"
          type="text"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="Enter email or username"
          autoComplete="username"
          disabled={loading}
          autoFocus
        />
      </div>

      <div className="auth-field">
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter password"
          autoComplete="current-password"
          disabled={loading}
        />
      </div>

      <div className="auth-field auth-field-checkbox">
        <label htmlFor="login-stay-logged-in">
          <input
            id="login-stay-logged-in"
            type="checkbox"
            checked={stayLoggedIn}
            onChange={(e) => setStayLoggedIn(e.target.checked)}
            disabled={loading}
          />
          Stay logged in
        </label>
      </div>

      <button
        type="submit"
        className="btn btn-primary auth-submit"
        disabled={loading || !identifier.trim() || !password}
      >
        {loading ? "Logging in..." : "Log In"}
      </button>

      <OAuthButtons providers={oauthProviders} />

      {onForgotPassword && (
        <p className="auth-switch">
          <button type="button" className="btn-link" onClick={onForgotPassword}>
            Forgot your password?
          </button>
        </p>
      )}

      <p className="auth-switch">
        Don't have an account?{" "}
        <button type="button" className="btn-link" onClick={onSwitchToRegister}>
          Register
        </button>
      </p>
    </form>
  );
}
