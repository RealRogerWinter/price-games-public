import { useState } from "react";
import { useUserAuth } from "../../context/UserAuthContext";
import { userUpdateEmail } from "../../api/userClient";
import { validateEmail } from "../../utils/validation";

/**
 * Form to change the user's email address.
 * Requires the new email and current password for verification.
 */
export default function ChangeEmailForm() {
  const { updateUser } = useUserAuth();
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function handleBlurEmail() {
    setFieldError(validateEmail(newEmail));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const emailErr = validateEmail(newEmail);
    if (emailErr) {
      setFieldError(emailErr);
      return;
    }
    if (!password) {
      setError("Password is required");
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await userUpdateEmail(newEmail.trim(), password);
      updateUser(res.user);
      setSuccess("Email updated successfully");
      setNewEmail("");
      setPassword("");
      setFieldError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update email";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h3 className="auth-form-subtitle">Change Email</h3>

      {error && <p className="auth-error">{error}</p>}
      {success && <p className="auth-success">{success}</p>}

      <div className="auth-field">
        <label htmlFor="change-email-new">New Email</label>
        <input
          id="change-email-new"
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onBlur={handleBlurEmail}
          placeholder="Enter new email"
          disabled={loading}
        />
        {fieldError && <span className="auth-field-error">{fieldError}</span>}
      </div>

      <div className="auth-field">
        <label htmlFor="change-email-password">Current Password</label>
        <input
          id="change-email-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter your password"
          autoComplete="current-password"
          disabled={loading}
        />
      </div>

      <button
        type="submit"
        className="btn btn-primary auth-submit"
        disabled={loading || !newEmail.trim() || !password}
      >
        {loading ? "Updating..." : "Update Email"}
      </button>
    </form>
  );
}
