import { useState } from "react";
import { userUpdatePassword } from "../../api/userClient";
import { validatePassword, validatePasswordMatch } from "../../utils/validation";

/**
 * Form to change the user's password.
 * Requires current password, new password, and confirmation.
 */
export default function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function handleBlur(field: string) {
    let err: string | null = null;
    switch (field) {
      case "newPassword":
        err = validatePassword(newPassword);
        break;
      case "confirmPassword":
        err = validatePasswordMatch(newPassword, confirmPassword);
        break;
    }
    setFieldErrors((prev) => ({ ...prev, [field]: err }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const passwordErr = validatePassword(newPassword);
    const matchErr = validatePasswordMatch(newPassword, confirmPassword);
    setFieldErrors({ newPassword: passwordErr, confirmPassword: matchErr });
    if (passwordErr || matchErr) return;
    if (!currentPassword) {
      setError("Current password is required");
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await userUpdatePassword(currentPassword, newPassword);
      setSuccess("Password updated successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setFieldErrors({});
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update password";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h3 className="auth-form-subtitle">Change Password</h3>

      {error && <p className="auth-error">{error}</p>}
      {success && <p className="auth-success">{success}</p>}

      <div className="auth-field">
        <label htmlFor="change-pw-current">Current Password</label>
        <input
          id="change-pw-current"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="Enter current password"
          autoComplete="current-password"
          disabled={loading}
        />
      </div>

      <div className="auth-field">
        <label htmlFor="change-pw-new">New Password</label>
        <input
          id="change-pw-new"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          onBlur={() => handleBlur("newPassword")}
          placeholder="At least 10 characters"
          autoComplete="new-password"
          disabled={loading}
        />
        {fieldErrors.newPassword && <span className="auth-field-error">{fieldErrors.newPassword}</span>}
      </div>

      <div className="auth-field">
        <label htmlFor="change-pw-confirm">Confirm New Password</label>
        <input
          id="change-pw-confirm"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          onBlur={() => handleBlur("confirmPassword")}
          placeholder="Re-enter new password"
          autoComplete="new-password"
          disabled={loading}
        />
        {fieldErrors.confirmPassword && <span className="auth-field-error">{fieldErrors.confirmPassword}</span>}
      </div>

      <button
        type="submit"
        className="btn btn-primary auth-submit"
        disabled={loading || !currentPassword || !newPassword || !confirmPassword}
      >
        {loading ? "Updating..." : "Update Password"}
      </button>
    </form>
  );
}
