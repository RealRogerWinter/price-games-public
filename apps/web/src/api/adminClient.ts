import type {
  AdminLoginResponse,
  AdminMeResponse,
  Admin2faSetupResponse,
  Admin2faVerifyEnableResponse,
  Admin2faStatusResponse,
  Admin2faVerifyLoginResponse,
  Admin2faRegenerateCodesResponse,
  AnalyticsOverview,
  AnalyticsGamesByDay,
  AnalyticsGamesByMode,
  AnalyticsPlayerActivity,
  AnalyticsCategoryStats,
  AnalyticsActiveRoom,
  AnalyticsScoreDistribution,
  AdminProductListResponse,
  AdminProductListParams,
  AdminProduct,
  AdminProductCreateRequest,
  AdminProductUpdateRequest,
  AdminBulkStatusResponse,
  AdminBulkArchiveResponse,
  AdminManufacturerWithContacts,
  AdminContact,
  AdminContactCreateRequest,
  AdminContactUpdateRequest,
  Reward,
  RewardListResponse,
  RewardListParams,
  RewardCreateRequest,
  QualifyingPlayersResponse,
  RandomRollCriteria,
  PromoBanner,
  GameModeSettings,
  AdminGamesForDateResponse,
  AdminUserRegistrationsDay,
  AdminUserRetention,
  AdminTopPlayer,
  AdminUserListParams,
  AdminUserListResponse,
  AdminUserDetail,
  AdminUserUpdateRequest,
  AdminUserGameHistoryResponse,
  UserStats,
  AdminUserActivityDay,
  AdminDailyOverviewResponse,
  AdminDailyPuzzleRow,
  AdminDailyStatsResponse,
  GameMode,
} from "@price-game/shared";

const BASE = "/api/admin";

/**
 * Bounce the browser to the admin login page on session expiry, unless
 * the user is already sitting on the login route (in which case a
 * redirect would be a no-op that hides the login error message). Used
 * by the admin API wrapper and any gallery-specific fetches that don't
 * go through adminRequest.
 */
function redirectToLoginIfStale(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/admin/login")) return;
  window.location.href = "/admin/login";
}

let sessionCheckInFlight: Promise<void> | null = null;

/**
 * Kick off a lightweight /me ping to detect whether the admin session
 * is still valid. On 401, the normal adminRequest wrapper will redirect
 * to the login page. Debounced so repeated calls within a few seconds
 * coalesce into a single request — useful as an `onError` handler on
 * image tags in the gallery, where dozens of thumbnails can fail at
 * once after session expiry.
 */
export function verifyAdminSessionDebounced(): void {
  if (sessionCheckInFlight) return;
  sessionCheckInFlight = adminGetMe()
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      // Clear the lock after a short cool-down so a later expiry can
      // retrigger the check.
      setTimeout(() => {
        sessionCheckInFlight = null;
      }, 5000);
    });
}

/**
 * Sends an authenticated request to the admin API.
 * @param url - The endpoint path (appended to /api/admin)
 * @param options - Optional fetch RequestInit overrides
 * @returns Parsed JSON response body
 * @throws Error if the response is not ok, with the server error message
 */
async function adminRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  if (!res.ok) {
    // On 401, assume the admin session expired and bounce the user back
    // to the login page. We skip this redirect for the login endpoint
    // itself so invalid-credential errors stay in-place.
    if (res.status === 401 && url !== "/login" && url !== "/login/verify-2fa") {
      redirectToLoginIfStale();
    }
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error || `API error ${res.status}`);
  }
  return res.json();
}

/**
 * Authenticates an admin user.
 * @param username - Admin username
 * @param password - Admin password
 * @returns The authenticated admin user data
 * @throws Error on invalid credentials (401)
 */
export function adminLogin(username: string, password: string): Promise<AdminLoginResponse> {
  return adminRequest<AdminLoginResponse>("/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

/**
 * Logs out the current admin session.
 * @returns Empty response on success
 */
export function adminLogout(): Promise<void> {
  return adminRequest<void>("/logout", {
    method: "POST",
  });
}

/**
 * Retrieves the currently authenticated admin user.
 * @returns The current admin user data
 * @throws Error on unauthenticated request (401)
 */
export function adminGetMe(): Promise<AdminMeResponse> {
  return adminRequest<AdminMeResponse>("/me");
}

// ── 2FA API ────────────────────────────────────────────────────────────────

/**
 * Completes 2FA login verification with a TOTP or recovery code.
 * @param pendingToken - The pending token from the login response.
 * @param code - The 6-digit TOTP code or 8-char recovery code.
 * @param isRecoveryCode - Whether the code is a recovery code.
 * @returns The authenticated admin user data.
 */
export function adminVerify2fa(
  pendingToken: string,
  code: string,
  isRecoveryCode?: boolean,
): Promise<Admin2faVerifyLoginResponse> {
  return adminRequest<Admin2faVerifyLoginResponse>("/login/verify-2fa", {
    method: "POST",
    body: JSON.stringify({ pendingToken, code, isRecoveryCode }),
  });
}

/**
 * Gets the current admin's 2FA status.
 * @returns 2FA status including enabled state and recovery code count.
 */
export function admin2faGetStatus(): Promise<Admin2faStatusResponse> {
  return adminRequest<Admin2faStatusResponse>("/2fa/status");
}

/**
 * Begins TOTP 2FA setup — generates a secret and QR code.
 * @returns Setup data including QR code, secret, and otpauth URI.
 */
export function admin2faBeginSetup(): Promise<Admin2faSetupResponse> {
  return adminRequest<Admin2faSetupResponse>("/2fa/setup", { method: "POST" });
}

/**
 * Verifies a TOTP code to complete 2FA setup, enabling 2FA.
 * @param code - The 6-digit TOTP code.
 * @returns Recovery codes for the user to save.
 */
export function admin2faVerifySetup(code: string): Promise<Admin2faVerifyEnableResponse> {
  return adminRequest<Admin2faVerifyEnableResponse>("/2fa/verify-setup", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

/**
 * Disables 2FA for the current admin.
 * @param password - Current password for re-authentication.
 * @param code - TOTP or recovery code.
 * @param isRecoveryCode - Whether the code is a recovery code.
 */
export function admin2faDisable(
  password: string,
  code: string,
  isRecoveryCode?: boolean,
): Promise<{ ok: boolean }> {
  return adminRequest<{ ok: boolean }>("/2fa/disable", {
    method: "POST",
    body: JSON.stringify({ password, code, isRecoveryCode }),
  });
}

/**
 * Regenerates recovery codes. Requires password re-verification.
 * @param password - Current password.
 * @returns New recovery codes.
 */
export function admin2faRegenerateCodes(password: string): Promise<Admin2faRegenerateCodesResponse> {
  return adminRequest<Admin2faRegenerateCodesResponse>("/2fa/regenerate-codes", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

/**
 * Fetches currently active multiplayer rooms. The lone /analytics/* v1
 * endpoint that survived PR #209 — kept because room-state is operational
 * data, not analytics-stream data. All other v1 dashboard endpoints
 * (overview, games-by-day, games-by-mode, player-activity, popular-
 * categories, score-distribution, user-registrations, user-retention,
 * top-players, games-for-date) were deleted; their replacements live
 * under /admin/analytics/v2/*.
 */
export function getActiveRooms(): Promise<AnalyticsActiveRoom[]> {
  return adminRequest<AnalyticsActiveRoom[]>("/analytics/active-rooms");
}

// ===== Product Management =====

/**
 * Fetches a paginated list of admin products with optional search/filter/sort.
 * @param params - Query parameters for filtering, sorting, and pagination.
 * @returns Paginated product list response.
 */
export function getAdminProducts(params?: AdminProductListParams): Promise<AdminProductListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.page !== undefined) searchParams.set("page", String(params.page));
  if (params?.pageSize !== undefined) searchParams.set("pageSize", String(params.pageSize));
  if (params?.search) searchParams.set("search", params.search);
  if (params?.category) searchParams.set("category", params.category);
  if (params?.isActive !== undefined) searchParams.set("isActive", String(params.isActive));
  if (params?.isArchived !== undefined) searchParams.set("isArchived", String(params.isArchived));
  if (params?.sortBy) searchParams.set("sortBy", params.sortBy);
  if (params?.sortOrder) searchParams.set("sortOrder", params.sortOrder);
  const qs = searchParams.toString();
  return adminRequest<AdminProductListResponse>(`/products${qs ? `?${qs}` : ""}`);
}

/**
 * Fetches a single product by ID.
 * @param id - Product ID.
 * @returns The product data.
 */
export function getAdminProduct(id: number): Promise<AdminProduct> {
  return adminRequest<AdminProduct>(`/products/${id}`);
}

/**
 * Creates a new product.
 * @param data - Product creation data.
 * @returns The created product.
 */
export function createAdminProduct(data: AdminProductCreateRequest): Promise<AdminProduct> {
  return adminRequest<AdminProduct>("/products", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/**
 * Updates an existing product.
 * @param id - Product ID.
 * @param data - Partial update data.
 * @returns The updated product.
 */
export function updateAdminProduct(id: number, data: AdminProductUpdateRequest): Promise<AdminProduct> {
  return adminRequest<AdminProduct>(`/products/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/**
 * Sets a product's active/inactive status.
 * @param id - Product ID.
 * @param isActive - Whether the product should be active.
 * @returns The updated product.
 */
export function setAdminProductStatus(id: number, isActive: boolean): Promise<AdminProduct> {
  return adminRequest<AdminProduct>(`/products/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ isActive }),
  });
}

/**
 * Bulk-updates the active status for multiple products.
 * @param ids - Array of product IDs.
 * @param isActive - Whether the products should be active.
 * @returns The number of products updated.
 */
export function bulkSetProductStatus(ids: number[], isActive: boolean): Promise<AdminBulkStatusResponse> {
  return adminRequest<AdminBulkStatusResponse>("/products/bulk-status", {
    method: "PATCH",
    body: JSON.stringify({ ids, isActive }),
  });
}

/**
 * Sets a product's archived status.
 * @param id - Product ID.
 * @param isArchived - Whether the product should be archived.
 * @returns The updated product.
 */
export function setAdminProductArchived(id: number, isArchived: boolean): Promise<AdminProduct> {
  return adminRequest<AdminProduct>(`/products/${id}/archive`, {
    method: "PATCH",
    body: JSON.stringify({ isArchived }),
  });
}

/**
 * Bulk-updates the archived status for multiple products.
 * @param ids - Array of product IDs.
 * @param isArchived - Whether the products should be archived.
 * @returns The number of products updated.
 */
export function bulkSetProductArchived(ids: number[], isArchived: boolean): Promise<AdminBulkArchiveResponse> {
  return adminRequest<AdminBulkArchiveResponse>("/products/bulk-archive", {
    method: "PATCH",
    body: JSON.stringify({ ids, isArchived }),
  });
}

/**
 * Fetches all distinct product categories.
 * @returns Array of category strings.
 */
export function getProductCategories(): Promise<string[]> {
  return adminRequest<string[]>("/products/categories");
}

// ===== Manufacturer Contacts =====

/**
 * Fetches manufacturer info and contacts by name.
 * @param name - Manufacturer name.
 * @returns Manufacturer with contacts, or throws if not found.
 */
export function getManufacturerContacts(name: string): Promise<AdminManufacturerWithContacts> {
  return adminRequest<AdminManufacturerWithContacts>(
    `/manufacturers/by-name/${encodeURIComponent(name)}`
  );
}

/**
 * Adds a new contact for a manufacturer.
 * @param manufacturerId - Manufacturer ID.
 * @param data - Contact creation data.
 * @returns The created contact.
 */
export function addManufacturerContact(
  manufacturerId: number,
  data: AdminContactCreateRequest
): Promise<AdminContact> {
  return adminRequest<AdminContact>(`/manufacturers/${manufacturerId}/contacts`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/**
 * Updates an existing manufacturer contact.
 * @param manufacturerId - Manufacturer ID.
 * @param contactId - Contact ID.
 * @param data - Partial update data.
 * @returns The updated contact.
 */
export function updateManufacturerContact(
  manufacturerId: number,
  contactId: number,
  data: AdminContactUpdateRequest
): Promise<AdminContact> {
  return adminRequest<AdminContact>(`/manufacturers/${manufacturerId}/contacts/${contactId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/**
 * Deletes a manufacturer contact.
 * @param manufacturerId - Manufacturer ID.
 * @param contactId - Contact ID.
 * @returns Success response.
 */
export function deleteManufacturerContact(
  manufacturerId: number,
  contactId: number
): Promise<{ ok: boolean }> {
  return adminRequest<{ ok: boolean }>(`/manufacturers/${manufacturerId}/contacts/${contactId}`, {
    method: "DELETE",
  });
}

// ===== Rewards =====

/**
 * Fetches a paginated list of rewards.
 * @param params - Optional filter/pagination parameters.
 * @returns Paginated reward list.
 */
export function getRewards(params?: RewardListParams): Promise<RewardListResponse> {
  const sp = new URLSearchParams();
  if (params?.page !== undefined) sp.set("page", String(params.page));
  if (params?.pageSize !== undefined) sp.set("pageSize", String(params.pageSize));
  if (params?.status) sp.set("status", params.status);
  const qs = sp.toString();
  return adminRequest<RewardListResponse>(`/rewards${qs ? `?${qs}` : ""}`);
}

/**
 * Adds a new reward to the pool.
 * @param data - Reward creation data.
 * @returns The created reward.
 */
export function createReward(data: RewardCreateRequest): Promise<Reward> {
  return adminRequest<Reward>("/rewards", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/**
 * Gets a single reward by ID.
 * @param id - Reward ID.
 * @returns The reward with award details.
 */
export function getRewardById(id: string): Promise<Reward> {
  return adminRequest<Reward>(`/rewards/${id}`);
}

/**
 * Deletes an available (unawarded) reward.
 * @param id - Reward ID.
 * @returns Success response.
 */
export function deleteReward(id: string): Promise<{ ok: boolean }> {
  return adminRequest<{ ok: boolean }>(`/rewards/${id}`, { method: "DELETE" });
}

/**
 * Manually awards a reward to a specific user.
 * @param rewardId - The reward to award.
 * @param userId - The user to receive the reward.
 * @returns The updated reward.
 */
export function awardReward(rewardId: string, userId: string): Promise<Reward> {
  return adminRequest<Reward>(`/rewards/${rewardId}/award`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

/**
 * Fetches qualifying players based on criteria. Supports the full new
 * criteria shape — calendar_month period, excluded user IDs, and the
 * excludeTestAccounts toggle.
 *
 * @param criteria - Qualification criteria for the roll.
 * @returns Matching players list.
 */
export function getQualifyingPlayers(criteria: RandomRollCriteria): Promise<QualifyingPlayersResponse> {
  const sp = new URLSearchParams({
    minPoints: String(criteria.minPoints),
    period: criteria.period,
    useLifetimePoints: String(criteria.useLifetimePoints),
    mode: criteria.mode ?? "points_only",
    minStreak: String(criteria.minStreak ?? 0),
  });
  if (criteria.month) {
    const mm = String(criteria.month.monthIndex + 1).padStart(2, "0");
    sp.set("month", `${criteria.month.year}-${mm}`);
  }
  if (criteria.excludedUserIds && criteria.excludedUserIds.length > 0) {
    sp.set("excludedUserIds", criteria.excludedUserIds.join(","));
  }
  if (criteria.excludeTestAccounts === false) {
    sp.set("excludeTestAccounts", "false");
  }
  return adminRequest<QualifyingPlayersResponse>(`/rewards/qualifying-players?${sp.toString()}`);
}

/**
 * Phase 1 of the two-phase roll. Picks a candidate winner and writes a
 * pending-review award row. **No emails are sent.** Follow up with
 * `confirmPendingAward` or `discardPendingAward`.
 *
 * @param rewardId - The reward to award.
 * @param criteria - Qualification criteria.
 * @returns The candidate award + reward + qualifying total.
 */
export function previewRandomRoll(
  rewardId: string,
  criteria: RandomRollCriteria,
): Promise<{
  candidateAward: { id: string; userId: string; username: string; email: string };
  reward: Reward;
  totalQualifying: number;
  nonWinnerNotifyCount: number;
}> {
  return adminRequest("/rewards/random-roll", {
    method: "POST",
    body: JSON.stringify({ rewardId, criteria }),
  });
}

/**
 * Phase 2: confirm a pending-review award. Sends the winner email + the
 * non-winner consolation batch and starts the claim window.
 */
export function confirmPendingAward(awardId: string): Promise<{ ok: true; reward: Reward }> {
  return adminRequest<{ ok: true; reward: Reward }>(`/rewards/awards/${awardId}/confirm`, {
    method: "POST",
  });
}

/**
 * Phase 2 alt: discard a pending-review award (no emails sent). Returns
 * the reward to the pool so the admin can re-roll.
 */
export function discardPendingAward(awardId: string): Promise<{ ok: true }> {
  return adminRequest<{ ok: true }>(`/rewards/awards/${awardId}/discard`, {
    method: "POST",
  });
}

/**
 * Searches users by username for manual reward awarding.
 * @param query - Username search string.
 * @returns Array of matching users.
 */
export function searchUsersForReward(
  query: string
): Promise<{ id: string; username: string; email: string; lifetimeScore: number }[]> {
  return adminRequest<{ id: string; username: string; email: string; lifetimeScore: number }[]>(
    `/rewards/search-users?q=${encodeURIComponent(query)}`
  );
}

// ===== Promo Banner =====

/**
 * Fetches the current promo banner settings.
 * @returns Banner configuration.
 */
export function getPromoBanner(): Promise<PromoBanner> {
  return adminRequest<PromoBanner>("/banner");
}

/**
 * Updates the promo banner settings.
 * @param data - Partial banner updates.
 * @returns Updated banner configuration.
 */
export function updatePromoBanner(data: Partial<PromoBanner>): Promise<PromoBanner> {
  return adminRequest<PromoBanner>("/banner", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ===== Legal Documents =====

/**
 * Fetches a legal document by key.
 * @param key - The document key ("privacy_policy" or "terms_of_service").
 * @returns The document key and markdown content.
 */
export function getLegalDocument(key: string): Promise<{ key: string; content: string }> {
  return adminRequest<{ key: string; content: string }>(`/legal/${key}`);
}

/**
 * Updates a legal document.
 * @param key - The document key ("privacy_policy" or "terms_of_service").
 * @param content - The markdown content to save.
 * @returns Success confirmation with the document key.
 */
export function updateLegalDocument(key: string, content: string): Promise<{ key: string; ok: boolean }> {
  return adminRequest<{ key: string; ok: boolean }>(`/legal/${key}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

// ===== Site Content (About, FAQ, Contact) =====

/**
 * Fetches an editable site content document.
 * @param key - One of "about", "faq", "contact".
 */
export function getContentDocument<T>(key: string): Promise<T> {
  return adminRequest<T>(`/content/${key}`);
}

/**
 * Updates an editable site content document.
 * @param key - One of "about", "faq", "contact".
 * @param content - Full document payload (shape depends on key).
 * @returns Server-normalized document and success flag.
 */
export function updateContentDocument<T>(key: string, content: T): Promise<{ key: string; ok: boolean; content: T }> {
  return adminRequest<{ key: string; ok: boolean; content: T }>(`/content/${key}`, {
    method: "PUT",
    body: JSON.stringify(content),
  });
}

// ===== Game Mode Settings =====

/**
 * Fetches the current game mode settings (all modes + disabled list).
 * @returns Game mode settings including which modes are disabled.
 */
export function getGameModeSettings(): Promise<GameModeSettings> {
  return adminRequest<GameModeSettings>("/game-modes");
}

/**
 * Updates the list of disabled game modes.
 * @param disabledModes - Array of game mode identifiers to disable.
 * @returns Updated game mode settings.
 */
export function updateGameModeSettings(disabledModes: string[]): Promise<GameModeSettings> {
  return adminRequest<GameModeSettings>("/game-modes", {
    method: "PUT",
    body: JSON.stringify({ disabledModes }),
  });
}

// ===== Ghost Users =====

/** Admin-facing settings shape for the ghost-user system. */
export interface GhostSettings {
  enabled: boolean;
  killSwitch: boolean;
  showOnLeaderboard: boolean;
  percentileCap: number;
  targetCount: number;
}

/** Admin-facing roster row. */
export interface GhostUserRow {
  id: string;
  username: string;
  username_normalized: string;
  avatar: string;
  lifetime_score: number;
  account_created_at: string;
  on_shift: number;
  shift_started_at: string | null;
  shift_ends_at: string | null;
  on_break_until: string | null;
  is_active: number;
  last_played_at: string | null;
  daily_streak_current: number;
  daily_streak_best: number;
  daily_streak_last_date: string | null;
  created_at: string;
  updated_at: string;
}

/** Read the current ghost-user system settings. */
export function getGhostSettings(): Promise<{ settings: GhostSettings }> {
  return adminRequest<{ settings: GhostSettings }>("/ghost-users/settings");
}

/** Partial-update ghost-user settings. Server clamps values; UI just forwards. */
export function updateGhostSettings(
  patch: Partial<GhostSettings>,
): Promise<{ settings: GhostSettings }> {
  return adminRequest<{ settings: GhostSettings }>("/ghost-users/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** Paginated roster list. */
export function listGhostUsers(opts: { limit?: number; offset?: number } = {}): Promise<{ ghosts: GhostUserRow[] }> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return adminRequest<{ ghosts: GhostUserRow[] }>(`/ghost-users${qs ? `?${qs}` : ""}`);
}

/** Bulk-create N ghosts (capped at 500 per call by the server). */
export function bulkCreateGhosts(count: number): Promise<{ created: number; ghosts: GhostUserRow[] }> {
  return adminRequest<{ created: number; ghosts: GhostUserRow[] }>("/ghost-users/bulk", {
    method: "POST",
    body: JSON.stringify({ count }),
  });
}

/** Update a ghost (deactivate / reactivate / force-end-shift). */
export function patchGhostUser(
  id: string,
  patch: { isActive?: boolean; endShift?: boolean },
): Promise<{ ghost: GhostUserRow | null }> {
  return adminRequest<{ ghost: GhostUserRow | null }>(`/ghost-users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Hard-delete a ghost. */
export function deleteGhostUser(id: string): Promise<{ deleted: boolean; id: string }> {
  return adminRequest<{ deleted: boolean; id: string }>(`/ghost-users/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Trigger emergency disable: sets killSwitch + ends every on-shift ghost. */
export function triggerGhostKillSwitch(): Promise<{ killSwitchActive: boolean; evictedShifts: number }> {
  return adminRequest<{ killSwitchActive: boolean; evictedShifts: number }>(
    "/ghost-users/kill-switch",
    { method: "POST" },
  );
}

// ===== Auto-Lobby Settings =====

/** All knobs the auto-lobby manager honors. Mirrors the server interface. */
export interface AutoLobbySettings {
  enabled: boolean;
  targetCount: number;
  targetMin: number;
  disguiseRatioMin: number;
  disguiseRatioMax: number;
  countdownMinSeconds: number;
  countdownMaxSeconds: number;
  modeAllowlist: string[];
}

/** Read the current auto-lobby system settings. */
export function getAutoLobbySettings(): Promise<{ settings: AutoLobbySettings }> {
  return adminRequest<{ settings: AutoLobbySettings }>("/auto-lobbies");
}

/** Partial-update auto-lobby settings. Server clamps + normalizes; UI just forwards. */
export function updateAutoLobbySettings(
  patch: Partial<AutoLobbySettings>,
): Promise<{ settings: AutoLobbySettings }> {
  return adminRequest<{ settings: AutoLobbySettings }>("/auto-lobbies", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

// ===== Avatar Settings =====

export interface AvatarSettings {
  avatars: readonly string[];
  labels: Record<string, string>;
  disabledAvatars: string[];
  userCounts: Record<string, number>;
}

/**
 * Fetches all avatars with their enabled/disabled status and user counts.
 * @returns Avatar settings including labels, disabled list, and user counts per avatar.
 */
export function getAvatarSettings(): Promise<AvatarSettings> {
  return adminRequest<AvatarSettings>("/avatars");
}

/**
 * Updates the list of disabled avatars.
 * @param disabledAvatars - Array of avatar identifiers to disable.
 * @returns Updated avatar settings.
 */
export function updateAvatarSettings(disabledAvatars: string[]): Promise<AvatarSettings> {
  return adminRequest<AvatarSettings>("/avatars", {
    method: "PUT",
    body: JSON.stringify({ disabledAvatars }),
  });
}

// ===== User Management =====
// Note: getGamesForDate, getUserRegistrations, getUserRetention,
// getTopPlayers were deleted alongside the v1 dashboard in PR #209.
// Replacements: Insights → Retention / Engagement / Geo tabs
// (`/admin/analytics/v2/*`).

/**
 * Fetches a paginated list of users with optional search/filter/sort.
 * @param params - Query parameters for filtering, sorting, and pagination.
 * @returns Paginated user list response.
 */
export function getAdminUsers(params?: AdminUserListParams): Promise<AdminUserListResponse> {
  const sp = new URLSearchParams();
  if (params?.page !== undefined) sp.set("page", String(params.page));
  if (params?.pageSize !== undefined) sp.set("pageSize", String(params.pageSize));
  if (params?.search) sp.set("search", params.search);
  if (params?.isActive !== undefined) sp.set("isActive", String(params.isActive));
  if (params?.sortBy) sp.set("sortBy", params.sortBy);
  if (params?.sortOrder) sp.set("sortOrder", params.sortOrder);
  const qs = sp.toString();
  return adminRequest<AdminUserListResponse>(`/users${qs ? `?${qs}` : ""}`);
}

/**
 * Fetches a single user by ID.
 * @param id - User ID.
 * @returns Detailed user data.
 */
export function getAdminUser(id: string): Promise<AdminUserDetail> {
  return adminRequest<AdminUserDetail>(`/users/${id}`);
}

/**
 * Updates a user's profile fields.
 * @param id - User ID.
 * @param data - Fields to update.
 * @returns Updated user data.
 */
export function updateAdminUser(id: string, data: AdminUserUpdateRequest): Promise<AdminUserDetail> {
  return adminRequest<AdminUserDetail>(`/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/**
 * Permanently deletes a user and all related data.
 * @param id - User ID.
 * @returns Success response.
 */
export function deleteAdminUser(id: string): Promise<{ ok: boolean }> {
  return adminRequest<{ ok: boolean }>(`/users/${id}`, { method: "DELETE" });
}

/**
 * Deactivates a user account.
 * @param id - User ID.
 * @returns Updated user data.
 */
export function deactivateAdminUser(id: string): Promise<AdminUserDetail> {
  return adminRequest<AdminUserDetail>(`/users/${id}/deactivate`, { method: "POST" });
}

/**
 * Reactivates a user account.
 * @param id - User ID.
 * @returns Updated user data.
 */
export function reactivateAdminUser(id: string): Promise<AdminUserDetail> {
  return adminRequest<AdminUserDetail>(`/users/${id}/reactivate`, { method: "POST" });
}

/**
 * Forces a password reset for a user, generating a temporary password.
 * @param id - User ID.
 * @returns Object containing the temporary password.
 */
export function resetAdminUserPassword(id: string): Promise<{ temporaryPassword: string }> {
  return adminRequest<{ temporaryPassword: string }>(`/users/${id}/reset-password`, { method: "POST" });
}

/**
 * Fetches paginated game history for a specific user.
 * @param id - User ID.
 * @param page - Page number (optional).
 * @param pageSize - Items per page (optional).
 * @returns Paginated game history response.
 */
export function getAdminUserGameHistory(
  id: string,
  page?: number,
  pageSize?: number
): Promise<AdminUserGameHistoryResponse> {
  const sp = new URLSearchParams();
  if (page !== undefined) sp.set("page", String(page));
  if (pageSize !== undefined) sp.set("pageSize", String(pageSize));
  const qs = sp.toString();
  return adminRequest<AdminUserGameHistoryResponse>(`/users/${id}/game-history${qs ? `?${qs}` : ""}`);
}

/**
 * Fetches aggregate game stats for a specific user.
 * @param id - User ID.
 * @returns User stats including total games, avg score, best score, etc.
 */
export function getAdminUserStats(id: string): Promise<UserStats> {
  return adminRequest<UserStats>(`/users/${id}/stats`);
}

/**
 * Fetches daily game activity for a specific user.
 * @param id - User ID.
 * @param days - Number of days to look back (optional, default 30).
 * @param timeZone - IANA timezone for day bucketing (optional; server default: ADMIN_TIMEZONE).
 * @returns Array of date/gamesPlayed pairs.
 */
export function getAdminUserActivity(id: string, days?: number, timeZone?: string): Promise<AdminUserActivityDay[]> {
  const sp = new URLSearchParams();
  if (days !== undefined) sp.set("days", String(days));
  if (timeZone) sp.set("tz", timeZone);
  const qs = sp.toString();
  return adminRequest<AdminUserActivityDay[]>(`/users/${id}/activity${qs ? `?${qs}` : ""}`);
}

// ===== UTM Tags =====

/** Lifecycle status of a UTM tag preset. */
export type AdminUtmTagStatus = "active" | "archived";

/** A UTM tag preset as returned by the admin API. */
export interface AdminUtmTag {
  id: string;
  name: string;
  utmSource: string;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  destinationUrl: string;
  status: AdminUtmTagStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  /** Optional short code that maps to a `/go/:code` public redirect. */
  shortCode: string | null;
  /** Number of short-link hits recorded for this tag. */
  clickCount: number;
  /** ISO timestamp of the most recent short-link hit, or null. */
  lastClickedAt: string | null;
  /**
   * Origin identifier for system-managed tags created by the outbound-links
   * service (one per email/push template type). Null for admin-created tags.
   * Non-null rows are read-only in the admin UI.
   */
  originKey: string | null;
}

/**
 * Origin filter for the listing endpoint.
 *   - `admin` (default): only admin-created tags (origin_key NULL).
 *   - `system`: only outbound-links-managed origin tags.
 *   - `all`: both.
 */
export type AdminUtmTagOriginFilter = "admin" | "system" | "all";

/** Paginated UTM tag list response. */
export interface AdminUtmTagListResponse {
  tags: AdminUtmTag[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Per-tag conversion funnel. */
export interface AdminUtmTagStats {
  tagId: string;
  signups: number;
  playedFirstGame: number;
  giveawayEligible: number;
  wonReward: number;
  giveawayThreshold: number;
  /** Short-link click count; always 0 when the tag has no short code. */
  clicks: number;
  /** Hint for UI layout: render the "Clicks" funnel row only when true. */
  hasShortCode: boolean;
  /**
   * Count of unclaimed anonymous visitors (visitor_attribution rows with
   * `first_game_at` set and `claimed_user_id` NULL) matching the tag's
   * UTM tuple. Represents pre-signup engagement — visitors who clicked
   * the tracking link and played ≥1 game without registering.
   */
  anonymousPlays: number;
}

/** Fields accepted by create/update endpoints. */
export interface AdminUtmTagInput {
  name?: string;
  utmSource?: string;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  destinationUrl?: string;
  /**
   * Optional short code. Pass `null` (or the empty string) to explicitly clear
   * a previously-set code on update; leave `undefined` to preserve the
   * existing value.
   */
  shortCode?: string | null;
}

/**
 * List UTM tag presets with optional status filter and pagination.
 * @param params - Optional filter/pagination params.
 * @returns Paginated tag list.
 */
export function listUtmTags(params?: {
  status?: AdminUtmTagStatus | "all";
  page?: number;
  pageSize?: number;
  origin?: AdminUtmTagOriginFilter;
}): Promise<AdminUtmTagListResponse> {
  const sp = new URLSearchParams();
  if (params?.status) sp.set("status", params.status);
  if (params?.origin) sp.set("origin", params.origin);
  if (params?.page !== undefined) sp.set("page", String(params.page));
  if (params?.pageSize !== undefined) sp.set("pageSize", String(params.pageSize));
  const qs = sp.toString();
  return adminRequest<AdminUtmTagListResponse>(`/utm-tags${qs ? `?${qs}` : ""}`);
}

/**
 * Create a new UTM tag preset.
 * @param data - The tag fields.
 * @returns The created tag.
 * @throws Error on validation failure (400) or duplicate name.
 */
export function createUtmTag(data: AdminUtmTagInput): Promise<AdminUtmTag> {
  return adminRequest<AdminUtmTag>("/utm-tags", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/**
 * Fetch a single UTM tag by id.
 * @param id - The tag id.
 * @returns The tag.
 * @throws Error on 404 if the tag does not exist.
 */
export function getUtmTag(id: string): Promise<AdminUtmTag> {
  return adminRequest<AdminUtmTag>(`/utm-tags/${id}`);
}

/**
 * Update fields on a UTM tag preset. Undefined fields are left unchanged.
 * @param id - The tag id.
 * @param data - Partial fields to update.
 * @returns The updated tag.
 * @throws Error on 404 if the tag does not exist, or 400 on validation failure.
 */
export function updateUtmTag(id: string, data: AdminUtmTagInput): Promise<AdminUtmTag> {
  return adminRequest<AdminUtmTag>(`/utm-tags/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/**
 * Archive or unarchive a UTM tag.
 * @param id - The tag id.
 * @param status - The new status.
 * @returns The updated tag.
 * @throws Error on 404 if the tag does not exist.
 */
export function setUtmTagStatus(
  id: string,
  status: AdminUtmTagStatus,
): Promise<AdminUtmTag> {
  return adminRequest<AdminUtmTag>(`/utm-tags/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

/**
 * Hard-delete a UTM tag. The server refuses (409) if the tag has already
 * matched any signups.
 * @param id - The tag id.
 * @returns Success response.
 * @throws Error on 404 if the tag does not exist, or 409 if it has matched signups.
 */
export function deleteUtmTag(id: string): Promise<{ ok: boolean }> {
  return adminRequest<{ ok: boolean }>(`/utm-tags/${id}`, { method: "DELETE" });
}

/** Trailing-window range supported by the UTM dashboard. */
export type AdminUtmRange = "7d" | "28d" | "90d";

/**
 * Fetch the 4-stage conversion funnel for a UTM tag:
 *   signups → played first game → giveaway-eligible → won reward.
 * When the tag has a short code, the response also includes a top-of-funnel
 * click counter (see `clicks` / `hasShortCode`).
 *
 * Pass `range` to restrict the funnel to a trailing window. Omit for the
 * lifetime view (existing default behavior — backward-compatible). Note
 * that `clicks` is always lifetime; the redirect handler does not log
 * per-click events so per-day click data does not exist.
 *
 * @param id - The tag id.
 * @param range - Optional trailing window.
 * @returns Funnel counts plus the giveaway eligibility threshold.
 * @throws Error on 404 if the tag does not exist.
 */
export function getUtmTagStats(
  id: string,
  range?: AdminUtmRange,
): Promise<AdminUtmTagStats> {
  const qs = range ? `?range=${range}` : "";
  return adminRequest<AdminUtmTagStats>(`/utm-tags/${id}/stats${qs}`);
}

/** One bucket of the per-tag daily traffic series. */
export interface AdminUtmTagTimeSeriesPoint {
  /** YYYY-MM-DD in admin TZ (default America/Los_Angeles). */
  date: string;
  sessions: number;
  signups: number;
  anonymousPlays: number;
}

/**
 * Fetch the per-tag daily traffic series over the given trailing window.
 *
 * @param id - The tag id.
 * @param range - Trailing window (`7d` / `28d` / `90d`).
 * @returns Daily points (zero-filled).
 * @throws Error on 404 if the tag does not exist, or 400 on bad range.
 */
export function getUtmTagTimeSeries(
  id: string,
  range: AdminUtmRange,
): Promise<AdminUtmTagTimeSeriesPoint[]> {
  return adminRequest<AdminUtmTagTimeSeriesPoint[]>(
    `/utm-tags/${id}/timeseries?range=${range}`,
  );
}

/** One row in the cross-tag comparison leaderboard. */
export interface AdminUtmTagComparisonRow {
  tagId: string;
  name: string;
  utmSource: string;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  status: AdminUtmTagStatus;
  originKey: string | null;
  hasShortCode: boolean;
  clicksLifetime: number;
  sessions: number;
  signups: number;
  anonymousPlays: number;
  conversionRate: number;
  ciLow: number;
  ciHigh: number;
  isLowSample: boolean;
  isSignificantlyAboveAverage: boolean;
  isSignificantlyBelowAverage: boolean;
  /** Last 7 daily signup counts, oldest → newest. Always 7 values. */
  sparkline: number[];
}

/** Summary aggregates across the comparison set, used for context cards. */
export interface AdminUtmTagComparisonSummary {
  totalClicksLifetime: number;
  totalSessions: number;
  totalSignups: number;
  totalAnonymousPlays: number;
  globalConversionRate: number;
  /**
   * Wilson 95% CI on the pooled sum(signups)/sum(sessions). `point` is null
   * when the global cohort is empty (n=0) — the server explicitly nulls
   * the NaN that wilsonInterval returns at the boundary so the wire shape
   * stays a clean number-or-null.
   */
  globalConversionCi: { point: number | null; lo: number; hi: number; halfWidth: number };
  rangeDays: number;
  activeTagCount: number;
}

/** Full comparison response. */
export interface AdminUtmTagComparisonResponse {
  rows: AdminUtmTagComparisonRow[];
  summary: AdminUtmTagComparisonSummary;
}

/**
 * Fetch the cross-tag leaderboard with Wilson 95% CIs, low-sample flags,
 * vs-average significance flags, and 7-day signup sparklines per tag.
 *
 * @param params - Query parameters.
 * @returns Ranked rows + summary.
 */
export function getUtmTagComparison(params: {
  range: AdminUtmRange;
  origin?: AdminUtmTagOriginFilter;
}): Promise<AdminUtmTagComparisonResponse> {
  const sp = new URLSearchParams();
  sp.set("range", params.range);
  if (params.origin) sp.set("origin", params.origin);
  return adminRequest<AdminUtmTagComparisonResponse>(
    `/utm-tags/comparison?${sp.toString()}`,
  );
}

/**
 * Ask the server for a freshly-generated short-code suggestion that does
 * not collide with any existing code. Used by the admin UI "Generate"
 * button next to the short-code input.
 *
 * @returns An object with a `code` field containing the suggested code.
 * @throws Error on 500 in the pathological case of repeated collisions.
 */
export function suggestShortCode(): Promise<{ code: string }> {
  return adminRequest<{ code: string }>("/utm-tags/short-code/suggest");
}

/**
 * Build the public short-link URL for a tag, or null if it has no code.
 * Mirrors the server-side helper so the admin UI can render a copy target
 * without calling the API.
 *
 * @param tag - A tag-shaped object with a `shortCode` field.
 * @param baseUrl - Canonical public site origin (use
 *   `getPublicSiteOrigin()` from `utils/publicSiteOrigin`). A single
 *   trailing slash is tolerated and stripped. NOTE: do NOT pass
 *   `window.location.origin` from admin surfaces — admins reach the panel
 *   via Tailscale and that would leak the Tailscale hostname into share URLs.
 * @returns `${baseUrl}/go/${shortCode}`, or null if `shortCode` is null.
 */
export function buildShortUrl(
  tag: { shortCode: string | null },
  baseUrl: string,
): string | null {
  if (!tag.shortCode) return null;
  const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmedBase}/go/${tag.shortCode}`;
}

// ─── Daily challenge admin ───────────────────────────────────────────

/**
 * Fetch the daily challenge admin overview (enabled state, schedule,
 * upcoming puzzles with play counts and product previews).
 *
 * @param days - Number of days to include in the window (default 14, max 60).
 * @param startDate - Optional YYYY-MM-DD start date. Defaults to today on the server.
 */
export function fetchAdminDailyOverview(
  days = 14,
  startDate?: string,
): Promise<AdminDailyOverviewResponse> {
  const params = new URLSearchParams({ days: String(days) });
  if (startDate) params.set("startDate", startDate);
  return adminRequest<AdminDailyOverviewResponse>(`/daily/overview?${params}`);
}

/** Toggle the daily_enabled site setting. */
export function updateAdminDailyEnabled(enabled: boolean): Promise<void> {
  return adminRequest("/daily/enabled", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

/** Replace the 7-slot weekly schedule. */
export function updateAdminDailySchedule(schedule: GameMode[]): Promise<{ schedule: GameMode[] }> {
  return adminRequest("/daily/schedule", {
    method: "PUT",
    body: JSON.stringify({ schedule }),
  });
}

/** Override the products for a specific daily date. */
export function setAdminDailyProducts(
  date: string,
  gameMode: GameMode,
  productIds: number[],
): Promise<AdminDailyPuzzleRow> {
  return adminRequest(`/daily/${date}/products`, {
    method: "PUT",
    body: JSON.stringify({ gameMode, productIds }),
  });
}

/** Regenerate a date's puzzle from seed. */
export function regenerateAdminDailyPuzzle(
  date: string,
  force = false,
): Promise<AdminDailyPuzzleRow> {
  return adminRequest(`/daily/${date}/regenerate`, {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}

/** Fetch aggregated daily stats (totals + 30-day breakdown + top streaks). */
export function fetchAdminDailyStats(): Promise<AdminDailyStatsResponse> {
  return adminRequest<AdminDailyStatsResponse>("/daily/stats");
}

/** Clear a user's play for a specific date (support tool). */
export function clearAdminDailyPlay(
  userId: string,
  date: string,
): Promise<{ deleted: number }> {
  return adminRequest(`/daily/plays/${userId}/${date}`, {
    method: "DELETE",
  });
}

// === Push Notifications ===

import type {
  NotificationTemplate,
  NotificationType,
  NotificationLogEntry,
  NotificationStats,
} from "@price-game/shared";

/** List all notification templates. */
export function fetchNotifTemplates(): Promise<{ templates: NotificationTemplate[] }> {
  return adminRequest("/notifications/templates");
}

/** Get a single notification template. */
export function fetchNotifTemplate(id: number): Promise<NotificationTemplate> {
  return adminRequest(`/notifications/templates/${id}`);
}

/** Create a new notification template. */
export function createNotifTemplate(data: {
  name: string;
  type: NotificationType;
  titleTemplate: string;
  bodyTemplate: string;
  icon?: string;
  urlPath?: string;
  ttl?: number;
  urgency?: string;
}): Promise<NotificationTemplate> {
  return adminRequest("/notifications/templates", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** Update a notification template. */
export function updateNotifTemplate(
  id: number,
  data: Partial<{
    name: string;
    type: NotificationType;
    titleTemplate: string;
    bodyTemplate: string;
    icon: string;
    urlPath: string;
    ttl: number;
    urgency: string;
    isActive: boolean;
  }>,
): Promise<NotificationTemplate> {
  return adminRequest(`/notifications/templates/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/** Delete a notification template. */
export function deleteNotifTemplate(id: number): Promise<{ ok: boolean }> {
  return adminRequest(`/notifications/templates/${id}`, {
    method: "DELETE",
  });
}

/** Send a notification manually (template-based or ad-hoc). */
export function sendNotification(data: {
  templateId?: number;
  userId?: string;
  title?: string;
  body?: string;
  type?: NotificationType;
  urlPath?: string;
  vars?: Record<string, string | number>;
}): Promise<{ ok: boolean; sent: number }> {
  return adminRequest("/notifications/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** Send a test notification to all subscribers (or a specific user). */
export function sendTestNotification(userId?: string): Promise<{ ok: boolean; sent: number }> {
  return adminRequest("/notifications/test", {
    method: "POST",
    body: JSON.stringify(userId ? { userId } : {}),
  });
}

/** Get notification statistics. */
export function fetchNotifStats(days?: number): Promise<NotificationStats> {
  const qs = days ? `?days=${days}` : "";
  return adminRequest(`/notifications/stats${qs}`);
}

/** Get paginated notification log. */
export function fetchNotifLog(params?: {
  page?: number;
  limit?: number;
  type?: NotificationType;
  status?: string;
  userId?: string;
}): Promise<{
  entries: NotificationLogEntry[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.type) qs.set("type", params.type);
  if (params?.status) qs.set("status", params.status);
  if (params?.userId) qs.set("userId", params.userId);
  const qsStr = qs.toString();
  return adminRequest(`/notifications/log${qsStr ? `?${qsStr}` : ""}`);
}

/** Get subscriber counts. */
export function fetchSubscriberCounts(): Promise<{ total: number; active: number }> {
  return adminRequest("/notifications/subscribers");
}

// ─── Asset Gallery ─────────────────────────────────────────────────────────

/**
 * Asset metadata record returned by the gallery API. Mirrors the
 * server's `AssetMetadata` shape (see apps/server/src/services/assetArchive.ts).
 */
export interface GalleryAsset {
  id: string;
  filename: string;
  title: string;
  category: string;
  tags: string[];
  description?: string;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  createdAt: string;
  updatedAt?: string;
  source?: "generated" | "migrated" | "imported";
  sizeBytes: number;
}

/** Patch body for updating an asset's metadata sidecar. */
export interface GalleryAssetPatch {
  title?: string;
  category?: string;
  tags?: string[];
  description?: string;
  prompt?: string;
  aspectRatio?: string;
  source?: "generated" | "migrated" | "imported";
}

/**
 * Fetch the full asset catalog from the gallery API. Called on page load
 * and when the user clicks Refresh — the server re-reads the archive
 * filesystem on every request so freshly-generated images show up
 * without any rebuild.
 */
export function fetchGalleryAssets(): Promise<{ assets: GalleryAsset[]; categories: string[] }> {
  return adminRequest("/gallery/assets");
}

/** Persist a metadata update for a single asset. */
export function updateGalleryAsset(id: string, patch: GalleryAssetPatch): Promise<GalleryAsset> {
  return adminRequest(`/gallery/assets/${encodeAssetId(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Permanently delete an asset (image + sidecar) from the archive. */
export async function deleteGalleryAsset(id: string): Promise<void> {
  const res = await fetch(`/api/admin/gallery/assets/${encodeAssetId(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) {
    if (res.status === 401) redirectToLoginIfStale();
    const body = await res.json().catch(() => ({ error: "Delete failed" }));
    throw new Error(body.error || `API error ${res.status}`);
  }
}

/**
 * Build the URL for fetching an asset's binary. Used as the `src` on
 * `<img>` tags inside the gallery grid. The browser sends the admin
 * session cookie automatically because the URL is same-origin.
 */
export function galleryAssetImageUrl(id: string): string {
  return `/api/admin/gallery/files/${encodeAssetId(id)}`;
}

/** Metadata fields common to every file in a single upload request. */
export interface GalleryUploadFields {
  namespace: string;
  category?: string;
  title?: string;
  tags?: string[];
  description?: string;
}

/** Response shape from POST /api/admin/gallery/upload. */
export interface GalleryUploadResponse {
  assets: GalleryAsset[];
  failures: { filename: string; error: string }[];
}

/**
 * Upload one or more image files to the archive. Used by the gallery
 * page's upload modal. Sends multipart/form-data so multer can parse
 * binary payloads on the server; the admin session cookie flows
 * automatically because the request is same-origin.
 */
export async function uploadGalleryAssets(
  files: File[],
  fields: GalleryUploadFields,
): Promise<GalleryUploadResponse> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  form.append("namespace", fields.namespace);
  if (fields.category) form.append("category", fields.category);
  if (fields.title) form.append("title", fields.title);
  if (fields.description) form.append("description", fields.description);
  if (fields.tags && fields.tags.length > 0) {
    form.append("tags", fields.tags.join(","));
  }

  const res = await fetch("/api/admin/gallery/upload", {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  if (!res.ok) {
    if (res.status === 401) redirectToLoginIfStale();
    const body = await res.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(body.error || `API error ${res.status}`);
  }
  return res.json();
}

/**
 * Asset ids contain slashes (`avatars/pirate.png`) — encode each segment
 * so URL routing works, while preserving the slashes the server expects
 * in the wildcard path capture.
 */
function encodeAssetId(id: string): string {
  return id.split("/").map(encodeURIComponent).join("/");
}

// === Email Notifications ==================================================

import type {
  EmailTemplate,
  EmailNotificationType,
  EmailLogEntry,
  EmailStats,
  EmailTriggerConfig,
  EmailPreferences,
} from "@price-game/shared";

/** List all email templates. */
export function fetchEmailTemplates(): Promise<{ templates: EmailTemplate[] }> {
  return adminRequest("/email/templates");
}

/** Fetch a single email template. */
export function fetchEmailTemplate(id: number): Promise<EmailTemplate> {
  return adminRequest(`/email/templates/${id}`);
}

/** Create a new email template. */
export function createEmailTemplate(data: {
  name: string;
  type: EmailNotificationType;
  subjectTemplate: string;
  htmlTemplate: string;
  textTemplate?: string | null;
  isActive?: boolean;
}): Promise<EmailTemplate> {
  return adminRequest("/email/templates", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** Update an email template. */
export function updateEmailTemplate(
  id: number,
  data: Partial<{
    name: string;
    type: EmailNotificationType;
    subjectTemplate: string;
    htmlTemplate: string;
    textTemplate: string | null;
    isActive: boolean;
  }>,
): Promise<EmailTemplate> {
  return adminRequest(`/email/templates/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/** Delete an email template. */
export function deleteEmailTemplate(id: number): Promise<{ ok: boolean }> {
  return adminRequest(`/email/templates/${id}`, { method: "DELETE" });
}

/** Dispatch an email via the admin panel. Mirrors POST /api/admin/email/send. */
export function sendAdminEmail(data: {
  templateId?: number;
  userId?: string;
  toAllOptedIn?: boolean;
  subject?: string;
  html?: string;
  text?: string;
  type?: EmailNotificationType;
  vars?: Record<string, string | number>;
  adminOverride?: boolean;
}): Promise<{
  ok: boolean;
  sent?: number;
  skipped?: number;
  reason?: string;
  byReason?: Record<string, number>;
}> {
  return adminRequest("/email/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** Send a minimal test email (either to a user id or a raw address). */
export function sendTestAdminEmail(data: {
  to?: string;
  userId?: string;
  adminOverride?: boolean;
}): Promise<{ ok: boolean; sent?: number; reason?: string; error?: string }> {
  return adminRequest("/email/send-test", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** Aggregate email stats for the admin dashboard. */
export function fetchEmailStats(days?: number): Promise<EmailStats> {
  const qs = days ? `?days=${days}` : "";
  return adminRequest(`/email/stats${qs}`);
}

/** Paginated email log. */
export function fetchEmailLog(params?: {
  page?: number;
  limit?: number;
  type?: EmailNotificationType;
  status?: string;
  userId?: string;
}): Promise<{
  entries: EmailLogEntry[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.type) qs.set("type", params.type);
  if (params?.status) qs.set("status", params.status);
  if (params?.userId) qs.set("userId", params.userId);
  const s = qs.toString();
  return adminRequest(`/email/log${s ? `?${s}` : ""}`);
}

/** Trigger configs (one row per email trigger type). */
export function fetchEmailTriggers(): Promise<{ triggers: EmailTriggerConfig[] }> {
  return adminRequest("/email/triggers");
}

/** Update a single trigger. Omitted fields stay unchanged. */
export function updateEmailTrigger(
  type: EmailNotificationType,
  data: Partial<{
    isEnabled: boolean;
    cooldownHours: number;
    thresholdJson: string | null;
    templateId: number | null;
  }>,
): Promise<EmailTriggerConfig> {
  return adminRequest(`/email/triggers/${type}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/** Read a specific user's email preferences (admin view). */
export function fetchUserEmailPreferences(userId: string): Promise<EmailPreferences> {
  return adminRequest(`/email/preferences/${userId}`);
}

/** Update a specific user's email preferences (admin override). */
export function updateUserEmailPreferences(
  userId: string,
  prefs: Partial<EmailPreferences>,
): Promise<EmailPreferences> {
  return adminRequest(`/email/preferences/${userId}`, {
    method: "PUT",
    body: JSON.stringify(prefs),
  });
}

// ===== Public Page Visibility =====

/** Admin-facing shape of the page-visibility map. Mirrors
 *  `EnabledPages` in `apps/web/src/api/content.ts`. */
export interface AdminEnabledPages {
  about: boolean;
  faq: boolean;
  contact: boolean;
  game_modes: boolean;
  privacy: boolean;
  terms: boolean;
}

/** Fetch the current visibility map for the six public SEO pages. */
export function getEnabledPagesAdmin(): Promise<{ pages: AdminEnabledPages }> {
  return adminRequest<{ pages: AdminEnabledPages }>("/pages");
}

/**
 * Replace the visibility map. Unknown keys are dropped by the server;
 * missing keys are persisted as `false`.
 */
export function updateEnabledPagesAdmin(
  pages: AdminEnabledPages,
): Promise<{ pages: AdminEnabledPages }> {
  return adminRequest<{ pages: AdminEnabledPages }>("/pages", {
    method: "PUT",
    body: JSON.stringify({ pages }),
  });
}

// ===== Referral Analytics =====

import type {
  AdminReferralRange,
  AdminReferralSummary,
  AdminReferralDailyPoint,
  AdminReferralTopReferrer,
  AdminReferralRejectionBucket,
  AdminReferredUser,
} from "@price-game/shared";

/** Fetch aggregate referral KPIs for the given window. */
export function getReferralAnalyticsSummary(
  range: AdminReferralRange = "28d",
): Promise<AdminReferralSummary> {
  return adminRequest<AdminReferralSummary>(
    `/analytics/referrals/summary?range=${encodeURIComponent(range)}`,
  );
}

/** Fetch the zero-filled daily created/credited series. */
export function getReferralAnalyticsDaily(
  range: AdminReferralRange = "28d",
): Promise<AdminReferralDailyPoint[]> {
  return adminRequest<AdminReferralDailyPoint[]>(
    `/analytics/referrals/daily?range=${encodeURIComponent(range)}`,
  );
}

/** Fetch the top referrers leaderboard. */
export function getReferralAnalyticsTopReferrers(
  range: AdminReferralRange = "28d",
  limit: number = 20,
): Promise<AdminReferralTopReferrer[]> {
  const sp = new URLSearchParams({ range, limit: String(limit) });
  return adminRequest<AdminReferralTopReferrer[]>(
    `/analytics/referrals/top-referrers?${sp.toString()}`,
  );
}

/** Fetch the rejection-reason breakdown. */
export function getReferralAnalyticsRejections(
  range: AdminReferralRange = "28d",
): Promise<AdminReferralRejectionBucket[]> {
  return adminRequest<AdminReferralRejectionBucket[]>(
    `/analytics/referrals/rejections?range=${encodeURIComponent(range)}`,
  );
}

/** Fetch the list of users referred by a single referrer. */
export function getReferralAnalyticsByReferrer(
  referrerId: string,
  range: AdminReferralRange = "28d",
): Promise<AdminReferredUser[]> {
  const sp = new URLSearchParams({ referrerId, range });
  return adminRequest<AdminReferredUser[]>(
    `/analytics/referrals/by-referrer?${sp.toString()}`,
  );
}

// ─── Admin leaderboard moderation ────────────────────────────────────────

export interface AdminLbEntry {
  id: number;
  playerName: string;
  score: number;
  playedAt: string | null;
  gameMode: string;
  sessionId: string | null;
  userId: string | null;
  username: string | null;
  isExcluded: boolean;
  excludedAt: string | null;
  excludedByAdminId: string | null;
  excludedReason: string | null;
  userBanned: boolean;
  userIsTest: boolean;
}

export interface AdminLbEntriesResponse {
  entries: AdminLbEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminLbUserSummary {
  userId: string;
  username: string;
  email: string | null;
  lifetimeScore: number;
  totalEntries: number;
  excludedEntries: number;
  bestScore: number;
  banned: boolean;
  bannedAt: string | null;
  bannedUntil: string | null;
  bannedReason: string | null;
  bannedBy: string | null;
  isTestAccount: boolean;
  recentEntries: AdminLbEntry[];
}

export interface AdminLbAuditEntry {
  id: number;
  adminUserId: string;
  adminUsername: string;
  action: string;
  targetType: "entry" | "user";
  targetId: string;
  targetLabel: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminLbStats {
  totalEntries: number;
  excludedEntries: number;
  bannedUsers: number;
  testAccounts: number;
}

export interface AdminLbEntryFilters {
  mode?: string;
  search?: string;
  scoreMin?: number;
  scoreMax?: number;
  dateFrom?: string;
  dateTo?: string;
  status?: "active" | "excluded" | "all";
  limit?: number;
  offset?: number;
  sort?: "score" | "playedAt";
  direction?: "asc" | "desc";
}

function toQuery(params: Record<string, string | number | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

/** Aggregate counts shown on the panel header strip. */
export function getLbStats(): Promise<AdminLbStats> {
  return adminRequest<AdminLbStats>("/leaderboard/stats");
}

/** List leaderboard entries with admin filters and pagination. */
export function getLbEntries(filters: AdminLbEntryFilters = {}): Promise<AdminLbEntriesResponse> {
  return adminRequest<AdminLbEntriesResponse>(
    `/leaderboard/entries${toQuery(filters as Record<string, string | number | undefined | null>)}`,
  );
}

/** Soft-exclude a single leaderboard entry. */
export function excludeLbEntry(id: number, reason: string): Promise<AdminLbEntry> {
  return adminRequest<AdminLbEntry>(`/leaderboard/entries/${id}/exclude`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** Restore a previously excluded entry. */
export function restoreLbEntry(id: number, reason?: string): Promise<AdminLbEntry> {
  return adminRequest<AdminLbEntry>(`/leaderboard/entries/${id}/restore`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** Bulk-exclude multiple entries with one reason. */
export function bulkExcludeLbEntries(
  ids: number[],
  reason: string,
): Promise<{ excluded: number; notFound: number }> {
  return adminRequest<{ excluded: number; notFound: number }>("/leaderboard/entries/bulk-exclude", {
    method: "POST",
    body: JSON.stringify({ ids, reason }),
  });
}

/** Resolve the per-account drilldown payload. */
export function getLbUserSummary(userId: string): Promise<AdminLbUserSummary> {
  return adminRequest<AdminLbUserSummary>(`/leaderboard/users/${encodeURIComponent(userId)}`);
}

/** Ban a user from the leaderboard. Optional `durationDays` for timed bans. */
export function banLbUser(
  userId: string,
  body: { reason: string; durationDays?: number },
): Promise<AdminLbUserSummary> {
  return adminRequest<AdminLbUserSummary>(
    `/leaderboard/users/${encodeURIComponent(userId)}/ban`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Ban a user from the leaderboard AND exclude every leaderboard entry
 * they own. Use when bad scores need to be wiped from history all at
 * once instead of moderated row-by-row.
 */
export function banLbUserHistory(
  userId: string,
  body: { reason: string; durationDays?: number },
): Promise<AdminLbUserSummary> {
  return adminRequest<AdminLbUserSummary>(
    `/leaderboard/users/${encodeURIComponent(userId)}/ban-history`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Lift a leaderboard ban. */
export function unbanLbUser(userId: string, reason?: string): Promise<AdminLbUserSummary> {
  return adminRequest<AdminLbUserSummary>(
    `/leaderboard/users/${encodeURIComponent(userId)}/unban`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

/** Toggle the test-account flag on a user. */
export function setLbTestAccountFlag(userId: string, isTest: boolean): Promise<AdminLbUserSummary> {
  return adminRequest<AdminLbUserSummary>(
    `/leaderboard/users/${encodeURIComponent(userId)}/test-flag`,
    { method: "POST", body: JSON.stringify({ isTest }) },
  );
}

/** List currently-banned users. */
export function getLbBannedUsers(opts: { limit?: number; offset?: number } = {}): Promise<{
  users: Omit<AdminLbUserSummary, "recentEntries">[];
  total: number;
}> {
  return adminRequest<{ users: Omit<AdminLbUserSummary, "recentEntries">[]; total: number }>(
    `/leaderboard/banned${toQuery(opts)}`,
  );
}

/** Read the moderation audit log. */
export function getLbAuditLog(opts: {
  limit?: number;
  offset?: number;
  action?: string;
  targetType?: "entry" | "user";
  targetId?: string;
} = {}): Promise<{ entries: AdminLbAuditEntry[]; total: number }> {
  return adminRequest<{ entries: AdminLbAuditEntry[]; total: number }>(
    `/leaderboard/audit${toQuery(opts)}`,
  );
}
