/**
 * Error class for user-facing error messages that are safe to return to clients.
 *
 * Use this for validation errors, business logic errors, and any error whose
 * message should be shown to the end user. All other errors will be logged
 * server-side and replaced with a generic "Something went wrong" message.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/**
 * Extract a safe error message from an unknown error.
 * Returns the original message for UserFacingError instances,
 * logs and returns a generic message for everything else.
 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof UserFacingError) {
    return err.message;
  }
  console.error("[UnexpectedError]", err);
  return "Something went wrong";
}
