/**
 * Validates a username string.
 * Must be 3-20 characters, alphanumeric and underscores only.
 * @param v - The username to validate
 * @returns null if valid, or an error message string
 */
export function validateUsername(v: string): string | null {
  if (!v) return "Username is required";
  if (v.length < 3) return "Username must be at least 3 characters";
  if (v.length > 20) return "Username must be at most 20 characters";
  if (!/^[a-zA-Z0-9_]+$/.test(v)) return "Username can only contain letters, numbers, and underscores";
  return null;
}

/**
 * Validates an email string.
 * Must contain an @ symbol.
 * @param v - The email to validate
 * @returns null if valid, or an error message string
 */
export function validateEmail(v: string): string | null {
  if (!v) return "Email is required";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Please enter a valid email address";
  return null;
}

/**
 * Validates a password string.
 * Must be 10-128 characters.
 * @param v - The password to validate
 * @returns null if valid, or an error message string
 */
export function validatePassword(v: string): string | null {
  if (!v) return "Password is required";
  if (v.length < 10) return "Password must be at least 10 characters";
  if (v.length > 128) return "Password must be at most 128 characters";
  return null;
}

/**
 * Validates that two passwords match.
 * @param p - The password
 * @param c - The confirmation password
 * @returns null if they match, or an error message string
 */
export function validatePasswordMatch(p: string, c: string): string | null {
  if (p !== c) return "Passwords do not match";
  return null;
}
