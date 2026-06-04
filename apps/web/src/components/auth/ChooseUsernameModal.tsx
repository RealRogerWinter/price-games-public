import { useState, useEffect } from "react";
import { validateUsername } from "../../utils/validation";
import { userSetUsername } from "../../api/userClient";
import type { UserAccount } from "@price-game/shared";

interface ChooseUsernameModalProps {
  onComplete: (user: UserAccount) => void;
}

/**
 * Modal that prompts new OAuth users to choose a username.
 * Cannot be dismissed — the user must pick a valid username to proceed.
 * @param onComplete - Called with the updated user after username is set.
 */
export default function ChooseUsernameModal({ onComplete }: ChooseUsernameModalProps) {
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingUser, setPendingUser] = useState<UserAccount | null>(null);
  const [emailVerificationSent, setEmailVerificationSent] = useState(false);

  // Block Escape key — modal cannot be dismissed
  useEffect(() => {
    function blockEscape(e: KeyboardEvent) {
      if (e.key === "Escape") e.preventDefault();
    }
    document.addEventListener("keydown", blockEscape);
    return () => document.removeEventListener("keydown", blockEscape);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const clientError = validateUsername(username.trim());
    if (clientError) {
      setError(clientError);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await userSetUsername(username.trim());
      if (res.emailVerificationSent) {
        setPendingUser(res.user);
        setEmailVerificationSent(true);
      } else {
        onComplete(res.user);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to set username";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  // Show email verification notice after username is set
  if (emailVerificationSent && pendingUser) {
    return (
      <div className="auth-modal-overlay" data-testid="choose-username-modal">
        <div className="auth-modal-content">
          <div className="auth-form">
            <h2 className="auth-form-title">Confirm Your Email</h2>
            <p className="auth-form-subtitle">
              We sent a verification link to <strong>{pendingUser.email}</strong>.
              Please check your inbox and confirm your email address.
            </p>
            <button
              type="button"
              className="btn btn-primary auth-submit"
              onClick={() => onComplete(pendingUser)}
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-modal-overlay" data-testid="choose-username-modal">
      <div className="auth-modal-content">
        <form className="auth-form" onSubmit={handleSubmit}>
          <h2 className="auth-form-title">Choose Your Username</h2>
          <p className="auth-form-subtitle">
            Pick a username for your account. This is how other players will see you.
          </p>

          {error && <p className="auth-error">{error}</p>}

          <div className="auth-field">
            <label htmlFor="choose-username">Username</label>
            <input
              id="choose-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3-20 characters, letters, numbers, underscores"
              autoComplete="username"
              disabled={loading}
              autoFocus
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary auth-submit"
            disabled={loading || !username.trim()}
          >
            {loading ? "Saving..." : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
