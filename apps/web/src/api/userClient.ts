import type {
  UserRegisterResponse,
  UserLoginResponse,
  UserMeResponse,
  UserAccount,
  GameHistoryEntry,
  SharedGameRecord,
  UserStats,
  UserScoreHistoryDay,
  UserReward,
  ReferralDashboard,
  WinRecord,
  GameMode,
} from "@price-game/shared";

const BASE = "/api/user";

/**
 * Sends an authenticated request to the user API.
 * @param url - The endpoint path (appended to /api/user)
 * @param options - Optional fetch RequestInit overrides
 * @returns Parsed JSON response body
 * @throws Error if the response is not ok, with the server error message
 */
async function userRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error || `API error ${res.status}`);
  }
  return res.json();
}

/**
 * Registers a new user account.
 * @param username - Desired username
 * @param email - User email address
 * @param password - User password
 * @param options - Optional referral code, Turnstile token, and UTM attribution.
 * @returns The registered user data and verification status
 * @throws Error on validation failure or duplicate username/email
 */
export function userRegister(
  username: string,
  email: string,
  password: string,
  options?: {
    referralCode?: string;
    turnstileToken?: string;
    attribution?: Partial<Record<string, string>> | null;
  },
): Promise<UserRegisterResponse> {
  return userRequest<UserRegisterResponse>("/register", {
    method: "POST",
    body: JSON.stringify({
      username,
      email,
      password,
      referralCode: options?.referralCode,
      turnstileToken: options?.turnstileToken,
      attribution: options?.attribution,
    }),
  });
}

/**
 * Attach UTM attribution to a freshly-registered user (OAuth path).
 *
 * Used by the client after an OAuth sign-in lands on the home page: the
 * server can't carry attribution through the OAuth redirect, so the client
 * posts the stored attribution here once the session is established.
 *
 * @param attribution - UTM attribution object.
 * @returns { wasAttributed } — true if the server actually wrote the fields
 *          (first-touch-wins + 10-minute window apply).
 */
export function userAttributeSignup(
  attribution: Partial<Record<string, string>>,
): Promise<{ wasAttributed: boolean }> {
  return userRequest<{ wasAttributed: boolean }>("/attribute-signup", {
    method: "POST",
    body: JSON.stringify({ attribution }),
  });
}

/**
 * Fetches the user's referral dashboard data.
 * @returns Referral code, stats, and list of referrals.
 */
export function userGetReferralDashboard(): Promise<ReferralDashboard> {
  return userRequest<ReferralDashboard>("/referrals");
}

/**
 * Authenticates a user with identifier (email or username) and password.
 *
 * @param identifier - Email or username.
 * @param password - User password.
 * @param stayLoggedIn - When true, the server issues a persistent 30-day
 *                       cookie. When false, the server issues a
 *                       browser-session cookie (deleted on browser close)
 *                       backed by a 24-hour server session cap. When
 *                       omitted, the field is dropped from the request
 *                       body and the server applies its backwards-compat
 *                       default (persistent).
 * @returns The authenticated user data.
 * @throws Error on invalid credentials (401).
 */
export function userLogin(
  identifier: string,
  password: string,
  stayLoggedIn?: boolean,
): Promise<UserLoginResponse> {
  // Build the body conditionally so an omitted flag is truly absent from
  // the wire payload — important so existing server-side code paths that
  // key off presence (vs false) continue to work.
  const body: Record<string, unknown> = { identifier, password };
  if (stayLoggedIn !== undefined) {
    body.stayLoggedIn = stayLoggedIn;
  }
  return userRequest<UserLoginResponse>("/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Logs out the current user session.
 * @returns Empty response on success
 */
export function userLogout(): Promise<void> {
  return userRequest<void>("/logout", {
    method: "POST",
  });
}

/**
 * Retrieves the currently authenticated user.
 * @returns The current user data
 * @throws Error on unauthenticated request (401)
 */
export function userGetMe(): Promise<UserMeResponse> {
  return userRequest<UserMeResponse>("/me");
}

/**
 * Updates the current user's email address.
 * @param newEmail - The new email address
 * @param password - Current password for verification
 * @returns The updated user data
 * @throws Error on invalid password or duplicate email
 */
export function userUpdateEmail(newEmail: string, password: string): Promise<{ user: UserAccount }> {
  return userRequest<{ user: UserAccount }>("/email", {
    method: "PUT",
    body: JSON.stringify({ newEmail, password }),
  });
}

/**
 * Updates the current user's password.
 * @param currentPassword - The current password
 * @param newPassword - The new password
 * @returns Empty response on success
 * @throws Error on invalid current password
 */
export function userUpdatePassword(currentPassword: string, newPassword: string): Promise<void> {
  return userRequest<void>("/password", {
    method: "PUT",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

/**
 * Resends the email verification email.
 * @returns Empty response on success
 */
export function userResendVerification(): Promise<void> {
  return userRequest<void>("/resend-verification", {
    method: "POST",
  });
}

/**
 * Fetches the user's game history with pagination and optional filters.
 * @param limit - Number of entries to return (optional)
 * @param offset - Number of entries to skip (optional)
 * @param type - Filter by game type: "single" or "multiplayer" (optional)
 * @param gameMode - Filter by game mode slug (optional)
 * @returns Paginated game history entries and total count
 */
export function userGetHistory(
  limit?: number,
  offset?: number,
  type?: string,
  gameMode?: string,
): Promise<{ entries: GameHistoryEntry[]; total: number }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  if (type) params.set("gameType", type);
  if (gameMode) params.set("gameMode", gameMode);
  const query = params.toString() ? `?${params.toString()}` : "";
  return userRequest<{ entries: GameHistoryEntry[]; total: number }>(`/history${query}`);
}

/**
 * Fetches the round-by-round recap for one game in the user's history,
 * keyed by the history row's numeric id. Public endpoint — the server
 * returns any user's recap so the leaderboard player-profile modal can
 * link into it. Returns either a cached `shared_games` row (fast path)
 * or a freshly-synthesized snapshot (cold path for legacy rows).
 *
 * @param historyId - `user_game_history.id` of the game to review.
 * @returns A `SharedGameRecord` identical in shape to `GET /api/share/:id`.
 * @throws Error with message including "API error 404" when the id doesn't resolve.
 */
export function userGetHistoryRecap(historyId: number): Promise<SharedGameRecord> {
  return userRequest<SharedGameRecord>(`/history/${encodeURIComponent(String(historyId))}/recap`);
}

/**
 * Fetches the user's aggregated game statistics.
 * @returns The user's stats including total games, best score, etc.
 */
export function userGetStats(): Promise<UserStats> {
  return userRequest<UserStats>("/stats");
}

/**
 * Per-mode W/L breakdown row returned alongside the cached snapshot when
 * the caller passes `breakdown=mode`.
 */
export interface WinRecordByModeEntry {
  gameMode: GameMode;
  wins: number;
  losses: number;
  winRate: number | null;
}

/**
 * Fetches the lifetime W/L/Streak snapshot for the current viewer. Works
 * for logged-in users (cached on `users`) and anonymous visitors (cached
 * on `visitor_attribution` keyed by the `visitor_id` cookie). New
 * browsers receive a zeroed snapshot.
 *
 * @param breakdown - Pass "mode" to also receive a per-mode W/L array.
 *   Per-mode data is logged-in users only; visitors get only the snapshot.
 * @returns Snapshot and (optionally) per-mode breakdown.
 */
export function userGetWinRecord(
  breakdown?: "mode",
): Promise<{ record: WinRecord; byMode?: WinRecordByModeEntry[] }> {
  const qs = breakdown === "mode" ? "?breakdown=mode" : "";
  return userRequest<{ record: WinRecord; byMode?: WinRecordByModeEntry[] }>(
    `/win-record${qs}`,
  );
}

/**
 * Fetches the user's points earned in the current calendar month plus
 * their current active daily-challenge streak. Both values are needed to
 * render the giveaway progress tracker, which may gate on either criterion.
 * @returns Monthly points, games played this month, and current daily streak.
 */
export function userGetMonthlyPoints(): Promise<{ points: number; gamesPlayed: number; streak: number }> {
  return userRequest<{ points: number; gamesPlayed: number; streak: number }>("/monthly-points");
}

/**
 * Fetches the user's daily score history for chart display.
 *
 * @param days - Number of past days to include (default 30, max 365).
 * @param timeZone - IANA timezone for day bucketing. Defaults to the
 *   browser's resolved timezone, so chart buckets match the adjacent
 *   game-history table (which renders in browser-local time).
 * @returns Array of daily score aggregates.
 */
export function userGetScoreHistory(
  days?: number,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<{ history: UserScoreHistoryDay[] }> {
  const sp = new URLSearchParams();
  if (days !== undefined) sp.set("days", String(days));
  if (timeZone) sp.set("tz", timeZone);
  const qs = sp.toString();
  return userRequest<{ history: UserScoreHistoryDay[] }>(`/score-history${qs ? `?${qs}` : ""}`);
}

/**
 * Sets the current user's username (e.g. after OAuth registration).
 * @param username - Desired username.
 * @returns The updated user data, plus emailVerificationSent if a verification email was sent.
 * @throws Error on validation failure or duplicate username.
 */
export function userSetUsername(username: string): Promise<{ ok: boolean; user: UserAccount; emailVerificationSent?: boolean }> {
  return userRequest<{ ok: boolean; user: UserAccount; emailVerificationSent?: boolean }>("/username", {
    method: "PUT",
    body: JSON.stringify({ username }),
  });
}

/**
 * Update the user's avatar preference.
 *
 * @param avatar - A valid profile avatar name, or null to clear.
 * @returns The updated user account.
 */
export function userUpdateAvatar(avatar: string | null): Promise<{ ok: boolean; user: UserAccount }> {
  return userRequest<{ ok: boolean; user: UserAccount }>("/avatar", {
    method: "PUT",
    body: JSON.stringify({ avatar }),
  });
}

/**
 * Fetches the list of enabled avatars from the public settings endpoint.
 * No auth required — used by the avatar picker to filter available options.
 * @returns Object with enabledAvatars array.
 */
export function getEnabledAvatars(): Promise<{ enabledAvatars: string[] }> {
  return fetch("/api/settings/avatars").then((res) => {
    if (!res.ok) throw new Error("Failed to fetch enabled avatars");
    return res.json();
  });
}

/**
 * Fetches which OAuth providers are configured on the server.
 * @returns Object with boolean flags for each provider.
 */
export function userGetOAuthProviders(): Promise<{ google: boolean; facebook: boolean; amazon: boolean }> {
  return userRequest<{ google: boolean; facebook: boolean; amazon: boolean }>("/oauth/providers");
}

/**
 * Fetches the user's awarded rewards.
 * @returns Array of rewards with gift card details.
 */
export function userGetRewards(): Promise<{ rewards: UserReward[] }> {
  return userRequest<{ rewards: UserReward[] }>("/rewards");
}

/**
 * Marks a reward as collected by the user.
 * @param rewardId - The reward ID to claim.
 * @returns Success response.
 */
export function userClaimReward(rewardId: string): Promise<{ ok: boolean; code: string }> {
  return userRequest<{ ok: boolean; code: string }>(`/rewards/${rewardId}/claim`, {
    method: "POST",
  });
}

/**
 * Claim result variants returned by the token endpoint. The
 * discriminated `ok` flag mirrors the server's contract so the claim page
 * can render distinct messages without relying on HTTP status codes.
 */
export type ClaimByTokenResponse =
  | { ok: true; code: string; amountCents: number; rewardType: string }
  | {
      ok: false;
      reason: "invalid" | "wrong_user" | "expired" | "voided" | "already_claimed";
    };

/**
 * Claim a reward via the per-award token sent in the winner email.
 * Used by the `/claim/:token` page.
 *
 * Throws only on network errors; rejected business outcomes (expired,
 * invalid, etc.) come back as `{ ok: false, reason: ... }` with a non-2xx
 * status. We map both to the same return shape so callers can branch on
 * `result.ok`.
 *
 * @param token - The per-award claim token from the email link.
 */
export async function userClaimRewardByToken(token: string): Promise<ClaimByTokenResponse> {
  // Hand-rolled fetch (vs. userRequest) so we can read the JSON body on
  // 4xx responses — userRequest throws on non-2xx and discards the body.
  const res = await fetch("/api/user/rewards/claim-by-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
  return (await res.json()) as ClaimByTokenResponse;
}

/**
 * Verifies an email address using a verification token.
 * @param token - The verification token from the email link.
 * @returns Success response.
 * @throws Error on invalid or expired token.
 */
export function userVerifyEmail(token: string): Promise<{ ok: boolean }> {
  return userRequest<{ ok: boolean }>("/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/**
 * Requests a password reset email.
 * @param email - The email address to send the reset link to.
 * @returns Success response (always succeeds to prevent email enumeration).
 */
export function userForgotPassword(email: string): Promise<{ ok: boolean }> {
  return userRequest<{ ok: boolean }>("/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/**
 * Resets a user's password using a reset token.
 * @param token - The password reset token from the email link.
 * @param newPassword - The new password to set.
 * @returns Success response.
 * @throws Error on invalid/expired token or password validation failure.
 */
export function userResetPassword(token: string, newPassword: string): Promise<{ ok: boolean }> {
  return userRequest<{ ok: boolean }>("/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, newPassword }),
  });
}
