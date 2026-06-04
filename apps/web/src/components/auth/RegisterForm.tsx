import { useState, useEffect, useRef, useCallback } from "react";
import { useUserAuth } from "../../context/UserAuthContext";
import { validateUsername, validateEmail, validatePassword, validatePasswordMatch } from "../../utils/validation";
import OAuthButtons from "./OAuthButtons";

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";

interface RegisterFormProps {
  onSwitchToLogin: () => void;
}

/**
 * Registration form with username, email, password, confirm password,
 * Cloudflare Turnstile widget, and referral code support.
 * Performs client-side validation on blur and displays server errors.
 * @param onSwitchToLogin - Callback to switch to the login view.
 */
export default function RegisterForm({ onSwitchToLogin }: RegisterFormProps) {
  const { register, oauthProviders } = useUserAuth();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [referralCode] = useState(() => sessionStorage.getItem("referral_code") || "");

  // Turnstile state
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  // null = config not loaded yet; true/false = server's answer.
  // Defer rendering the widget until the server tells us whether it is on,
  // so the sandbox's SKIP_TURNSTILE=1 posture does not flash a challenge.
  const [turnstileEnabled, setTurnstileEnabled] = useState<boolean | null>(null);

  // Fetch server-side auth config to decide whether to render the widget.
  // On any fetch failure fall back to enabled — a false-positive widget is
  // safer than accidentally disabling the challenge in production.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/auth-config", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data.turnstileEnabled === "boolean") {
          setTurnstileEnabled(data.turnstileEnabled);
        } else {
          setTurnstileEnabled(true);
        }
      })
      .catch(() => { if (!cancelled) setTurnstileEnabled(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || turnstileEnabled !== true) return;

    // The Turnstile script used to live in index.html and load on every
    // page. Now we inject it lazily here so only the registration path
    // pays the cost. Idempotent — a second mount finds the existing tag
    // and reuses it.
    if (!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    function tryRender() {
      if (cancelled || !turnstileRef.current || !window.turnstile) return false;
      if (widgetIdRef.current) {
        try { window.turnstile!.remove(widgetIdRef.current); } catch { /* ignore */ }
        widgetIdRef.current = null;
      }
      widgetIdRef.current = window.turnstile!.render(turnstileRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => { if (!cancelled) setTurnstileToken(token); },
        "error-callback": () => { if (!cancelled) setTurnstileToken(null); },
        "expired-callback": () => { if (!cancelled) setTurnstileToken(null); },
        theme: "dark",
      });
      return true;
    }

    if (!tryRender()) {
      // Poll until the async Turnstile script finishes loading
      intervalId = setInterval(() => {
        if (tryRender() && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }, 300);
    }

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch { /* ignore */ }
        widgetIdRef.current = null;
      }
    };
  }, [turnstileEnabled]);

  function handleBlur(field: string) {
    let error: string | null = null;
    switch (field) {
      case "username":
        error = validateUsername(username);
        break;
      case "email":
        error = validateEmail(email);
        break;
      case "password":
        error = validatePassword(password);
        break;
      case "confirmPassword":
        error = validatePasswordMatch(password, confirmPassword);
        break;
    }
    setFieldErrors((prev) => ({ ...prev, [field]: error }));
  }

  function hasClientErrors(): boolean {
    const usernameErr = validateUsername(username);
    const emailErr = validateEmail(email);
    const passwordErr = validatePassword(password);
    const matchErr = validatePasswordMatch(password, confirmPassword);
    const errors = { username: usernameErr, email: emailErr, password: passwordErr, confirmPassword: matchErr };
    setFieldErrors(errors);
    return !!(usernameErr || emailErr || passwordErr || matchErr);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (hasClientErrors()) return;
    setLoading(true);
    setServerError(null);
    try {
      // UserAuthContext.register() reads stored UTM attribution and fires
      // the Reddit Pixel SignUp event atomically — no local handling needed.
      await register(username.trim(), email.trim(), password, {
        referralCode: referralCode || undefined,
        turnstileToken: turnstileToken || undefined,
      });
      // Clear referral code from sessionStorage on success
      sessionStorage.removeItem("referral_code");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Registration failed";
      setServerError(message);
      // Reset Turnstile on error so user can try again
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
        setTurnstileToken(null);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h2 className="auth-form-title">Create Account</h2>

      {serverError && <p className="auth-error">{serverError}</p>}

      {referralCode && (
        <div className="auth-referral-badge" data-testid="referral-badge">
          Referred by a friend
        </div>
      )}

      <div className="auth-field">
        <label htmlFor="register-username">Username</label>
        <input
          id="register-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onBlur={() => handleBlur("username")}
          placeholder="Choose a username"
          autoComplete="username"
          disabled={loading}
          autoFocus
        />
        {fieldErrors.username && <span className="auth-field-error">{fieldErrors.username}</span>}
      </div>

      <div className="auth-field">
        <label htmlFor="register-email">Email</label>
        <input
          id="register-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => handleBlur("email")}
          placeholder="Enter your email"
          disabled={loading}
        />
        {fieldErrors.email && <span className="auth-field-error">{fieldErrors.email}</span>}
      </div>

      <div className="auth-field">
        <label htmlFor="register-password">Password</label>
        <input
          id="register-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => handleBlur("password")}
          placeholder="At least 10 characters"
          autoComplete="new-password"
          disabled={loading}
        />
        {fieldErrors.password && <span className="auth-field-error">{fieldErrors.password}</span>}
      </div>

      <div className="auth-field">
        <label htmlFor="register-confirm">Confirm Password</label>
        <input
          id="register-confirm"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          onBlur={() => handleBlur("confirmPassword")}
          placeholder="Re-enter password"
          autoComplete="new-password"
          disabled={loading}
        />
        {fieldErrors.confirmPassword && <span className="auth-field-error">{fieldErrors.confirmPassword}</span>}
      </div>

      {TURNSTILE_SITE_KEY && turnstileEnabled === true && (
        <div className="auth-turnstile" ref={turnstileRef} data-testid="turnstile-widget" />
      )}

      <button
        type="submit"
        className="btn btn-primary auth-submit"
        disabled={loading}
      >
        {loading ? "Creating account..." : "Create Account"}
      </button>

      <OAuthButtons providers={oauthProviders} />

      <p className="auth-switch">
        Already have an account?{" "}
        <button type="button" className="btn-link" onClick={onSwitchToLogin}>
          Log In
        </button>
      </p>
    </form>
  );
}
