import type {
  GameSession,
  Product,
  GuessResponse,
  MPLeaderboardEntry,
  HigherLowerGuessResponse,
  ComparisonGuessResponse,
  ClosestGuessResponse,
  PriceMatchGuessResponse,
  RiserGuessResponse,
  OddOneOutGuessResponse,
  MarketBasketGuessResponse,
  SortItOutGuessResponse,
  BudgetBuilderGuessResponse,
  ChainReactionGuessResponse,
  CreateShareRequest,
  CreateShareResponse,
  SharedGameRecord,
  LeaderboardAvailability,
  LeaderboardGameType,
  LeaderboardPeriod,
  LifetimeLeaderboardEntry,
  LongestStreakLeaderboardEntry,
  PeriodLeaderboardEntry,
  PublicPlayerProfile,
  PublicGameHistoryEntry,
  UserScoreHistoryDay,
  UserRankResponse,
  UserRankHistoryDay,
} from "@price-game/shared";

const BASE = "/api";

/**
 * Kick off image downloads ahead of time so the browser has them in the
 * HTTP cache by the time the next round renders its product. Guarded
 * behind `Image` availability for SSR / test environments.
 *
 * The URL pattern is locked to the app's own `/api/image/<numericId>`
 * route. This is the only shape the server currently emits for this
 * hint and rejecting anything else prevents a future server-side
 * regression (or a tampered JSON body) from triggering cross-origin
 * preloads with the user's cookies attached.
 */
const PRELOAD_URL_ALLOW = /^\/api\/image\/\d+$/;

function preloadImages(urls: readonly string[]): void {
  if (typeof Image === "undefined") return;
  for (const url of urls) {
    if (typeof url !== "string" || !PRELOAD_URL_ALLOW.test(url)) continue;
    // Construct the Image but discard — the browser still fetches the src
    // into its cache. No onload/onerror handlers are registered, so a 404
    // is silently ignored (we never rely on the preload succeeding).
    new Image().src = url;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  const body = (await res.json()) as T & {
    nextRoundImageUrls?: string[];
    winRecord?: unknown;
  };
  // Opportunistic preload: any endpoint may return a `nextRoundImageUrls`
  // hint to warm the browser's image cache before the user advances. Today
  // only `/game/:id/guess` emits this; future endpoints are free to do the
  // same with no client-side wiring required.
  if (Array.isArray(body.nextRoundImageUrls) && body.nextRoundImageUrls.length > 0) {
    preloadImages(body.nextRoundImageUrls);
  }
  // When the server attaches a fresh winRecord (game-completion responses),
  // notify any mounted HUD chips to refetch. Decoupling via a window event
  // means individual game pages don't need to plumb the value through.
  if (body.winRecord && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("winrecord:changed"));
  }
  return body;
}

export function startGame(
  categories?: string[],
  mode?: string,
  rounds?: number,
  startSource?: string,
): Promise<GameSession> {
  return request<GameSession>("/game/start", {
    method: "POST",
    body: JSON.stringify({
      ...(categories?.length ? { categories } : {}),
      ...(mode ? { mode } : {}),
      ...(rounds !== undefined ? { rounds } : {}),
      ...(startSource ? { startSource } : {}),
    }),
  });
}

export function getCategories(): Promise<{
  categories: { name: string; count: number }[];
}> {
  return request("/game/categories");
}

export function getSession(sessionId: string): Promise<GameSession> {
  return request<GameSession>(`/game/${sessionId}`);
}

export async function getProduct(sessionId: string): Promise<Product> {
  // The server's `/game/:id/product` endpoint returns mode-specific
  // round data (a Product for classic, a `{ products, question }` for
  // comparison, etc.) under a Product type-cast. Forward the raw
  // response to the bot streamer so its strategies have the same
  // shape the UI does. Solo gameplay is REST-driven (no socket
  // events), so without this synthetic dispatch the bot's observer
  // would never see round_start and would time out waiting on every
  // round.
  const data = await request<Product>(`/game/${sessionId}/product`);
  // Only dispatch the bridge event when the page is in broadcast mode.
  // Unconditional dispatch was harmless (no listeners on a normal user's
  // page) but pointless work — the streamer's Chromium is the only
  // consumer of `pg-bot-event`, and it always loads with `?broadcast=1`.
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("broadcast") === "1") {
    // Pull the active session metadata (gameMode, currentRound,
    // totalRounds) out of sessionStorage where SinglePlayerApp
    // persists it. This is the same key the rejoin flow reads.
    let gameMode: string | undefined;
    let roundNumber: number | undefined;
    try {
      const raw = sessionStorage.getItem("active_game");
      if (raw) {
        const parsed = JSON.parse(raw) as { gameMode?: string; session?: { currentRound?: number } };
        gameMode = parsed.gameMode;
        roundNumber = parsed.session?.currentRound;
      }
    } catch { /* sessionStorage may throw in some embedded contexts */ }
    // Normalize: classic returns a bare Product, other modes return
    // wrappers like { product, referencePrice } / { products, ... }.
    // Detect bare-Product by the `title` top-level field and wrap it
    // so the strategies always see `payload.product` / `.products`.
    const raw = data as unknown as Record<string, unknown>;
    const looksLikeBareProduct = typeof raw.title === "string" && typeof raw.id === "number";
    const payload = looksLikeBareProduct
      ? { product: raw, gameMode, roundNumber }
      : { ...raw, gameMode, roundNumber };
    window.dispatchEvent(new CustomEvent("pg-bot-event", {
      detail: { kind: "game:round_start", payload },
    }));
  }
  return data;
}

export function submitGuess(
  sessionId: string,
  guessedPriceCents: number,
  timedOut?: boolean
): Promise<GuessResponse> {
  return request<GuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ guessedPriceCents, ...(timedOut && { timedOut: true }) }),
  });
}

export function submitHigherLowerGuess(
  sessionId: string,
  guess: "higher" | "lower",
  timedOut?: boolean
): Promise<HigherLowerGuessResponse> {
  return request<HigherLowerGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ guess, ...(timedOut && { timedOut: true }) }),
  });
}

export function submitComparisonGuess(
  sessionId: string,
  guessedProductId: number,
  timedOut?: boolean
): Promise<ComparisonGuessResponse> {
  return request<ComparisonGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ guessedProductId, ...(timedOut && { timedOut: true }) }),
  });
}

export function submitClosestGuess(
  sessionId: string,
  guessedPriceCents: number,
  timedOut?: boolean
): Promise<ClosestGuessResponse> {
  return request<ClosestGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ guessedPriceCents, ...(timedOut && { timedOut: true }) }),
  });
}

export function submitPriceMatchGuess(
  sessionId: string,
  assignments: Record<number, number>
): Promise<PriceMatchGuessResponse> {
  return request<PriceMatchGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ assignments }),
  });
}

export function submitRiserGuess(
  sessionId: string,
  stoppedPriceCents: number
): Promise<RiserGuessResponse> {
  return request<RiserGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ stoppedPriceCents }),
  });
}

export function submitOddOneOutGuess(
  sessionId: string,
  guessedProductId: number,
  timedOut?: boolean
): Promise<OddOneOutGuessResponse> {
  return request<OddOneOutGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ guessedProductId, ...(timedOut && { timedOut: true }) }),
  });
}

export function submitMarketBasketGuess(
  sessionId: string,
  guessedTotalCents: number,
  timedOut?: boolean
): Promise<MarketBasketGuessResponse> {
  return request<MarketBasketGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ guessedTotalCents, ...(timedOut && { timedOut: true }) }),
  });
}

export function submitSortItOutGuess(
  sessionId: string,
  submittedOrder: number[],
  timedOut?: boolean
): Promise<SortItOutGuessResponse> {
  return request<SortItOutGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ submittedOrder, ...(timedOut && { timedOut: true }) }),
  });
}

export function submitBudgetBuilderGuess(
  sessionId: string,
  selectedProductIds: number[],
  timedOut?: boolean
): Promise<BudgetBuilderGuessResponse> {
  return request<BudgetBuilderGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ selectedProductIds, ...(timedOut && { timedOut: true }) }),
  });
}

export function submitChainReactionGuess(
  sessionId: string,
  chainGuesses: ("more" | "less")[],
  timedOut?: boolean
): Promise<ChainReactionGuessResponse> {
  return request<ChainReactionGuessResponse>(`/game/${sessionId}/guess`, {
    method: "POST",
    body: JSON.stringify({ chainGuesses, ...(timedOut && { timedOut: true }) }),
  });
}

export function getHint(
  sessionId: string
): Promise<{ hintRange: { min: number; max: number } }> {
  return request(`/game/${sessionId}/hint`, { method: "POST" });
}

/** Fetch the multiplayer leaderboard, optionally filtered by game mode. */
export function getMpLeaderboard(mode?: string): Promise<{ entries: MPLeaderboardEntry[] }> {
  const query = mode ? `?mode=${encodeURIComponent(mode)}` : "";
  return request<{ entries: MPLeaderboardEntry[] }>(`/mp/leaderboard${query}`);
}

/**
 * Create a shareable game record. Returns the new share id + relative URL
 * (`/s/<id>`). Used by ShareModal to mint a short link at the moment the
 * player opens the modal; failure (network, rate limit, server error) is
 * handled by the caller via the default rejected promise — ShareModal silently
 * falls back to the default footer when rejected.
 */
export function createShare(payload: CreateShareRequest): Promise<CreateShareResponse> {
  return request<CreateShareResponse>("/share", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Fetch a previously-created shareable game record for read-only rendering
 * on the /s/:id page.
 * @throws When the id is malformed (API returns 400) or missing (API returns 404)
 */
export function getShare(id: string): Promise<SharedGameRecord> {
  return request<SharedGameRecord>(`/share/${encodeURIComponent(id)}`);
}

// ─── Leaderboard V2 ───

/**
 * Fetch the score leaderboard (v2) with pagination, optional period, and
 * optional game-type slice.
 *
 * For `period="all"` and `gameType="all"` (defaults) the response rows are
 * `LifetimeLeaderboardEntry` (score field: `lifetimeScore`) and rank by the
 * pre-aggregated `users.lifetime_score`. Bounded periods or non-"all"
 * `gameType` slices return `LifetimeLeaderboardEntry`/`PeriodLeaderboardEntry`
 * rows summed from `user_game_history`. Callers should branch on the returned
 * `period` to pick the score field.
 */
export function getLeaderboardV2(
  limit: number = 50,
  offset: number = 0,
  period: LeaderboardPeriod = "all",
  gameType: LeaderboardGameType = "all",
): Promise<{
  leaderboard: LifetimeLeaderboardEntry[] | PeriodLeaderboardEntry[];
  period: LeaderboardPeriod;
  gameType: LeaderboardGameType;
  total: number;
}> {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (period !== "all") qs.set("period", period);
  if (gameType !== "all") qs.set("gameType", gameType);
  return request<{
    leaderboard: LifetimeLeaderboardEntry[] | PeriodLeaderboardEntry[];
    period: LeaderboardPeriod;
    gameType: LeaderboardGameType;
    total: number;
  }>(`/leaderboard/v2?${qs}`);
}

/**
 * Fetch the count of players with any recorded score per period.
 * Used by the leaderboard page to hide pills for empty periods.
 */
export function getLeaderboardAvailability(): Promise<LeaderboardAvailability> {
  return request<LeaderboardAvailability>(`/leaderboard/v2/availability`);
}

/** Fetch the top players by longest daily-challenge streak. */
export function getLongestStreakLeaderboard(
  limit: number = 20,
): Promise<{ leaderboard: LongestStreakLeaderboardEntry[] }> {
  return request<{ leaderboard: LongestStreakLeaderboardEntry[] }>(
    `/leaderboard/streaks?limit=${limit}`,
  );
}

/**
 * Ask the multiplayer matchmaker whether to join an existing public lobby
 * or create a fresh one. Used by the Quick Play flow.
 *
 * @param gameMode - Optional mode filter; omit for "any mode".
 * @param totalRounds - Optional rounds filter (3, 5, 10); omit for "any".
 * @returns { action: "join", roomCode } | { action: "create" }
 */
export function quickplayMatch(
  gameMode?: string,
  totalRounds?: number,
): Promise<{ action: "join"; roomCode: string } | { action: "create" }> {
  return request<{ action: "join"; roomCode: string } | { action: "create" }>(
    "/mp/quickplay",
    {
      method: "POST",
      body: JSON.stringify({ gameMode, totalRounds }),
    },
  );
}

/** Fetch the current user's rank on the lifetime leaderboard (includes bestRank). */
export function getUserRank(): Promise<UserRankResponse> {
  return request<UserRankResponse>("/leaderboard/rank");
}

/**
 * Fetch the authenticated user's rank history for the rank-over-time chart.
 *
 * @param days - Lookback window (default 30, max 365).
 * @param timeZone - IANA timezone for day bucketing. Defaults to the
 *   browser's resolved timezone so chart labels match the game-history
 *   list next to it.
 */
export function getRankHistory(
  days: number = 30,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<{ history: UserRankHistoryDay[] }> {
  const sp = new URLSearchParams({ days: String(days) });
  if (timeZone) sp.set("tz", timeZone);
  return request<{ history: UserRankHistoryDay[] }>(
    `/leaderboard/rank/history?${sp.toString()}`,
  );
}

/** Fetch a public player profile by username. */
export function getPublicProfile(
  username: string,
): Promise<{ profile: PublicPlayerProfile }> {
  return request<{ profile: PublicPlayerProfile }>(
    `/player/${encodeURIComponent(username)}`,
  );
}

/**
 * Fetch daily score history for a public player profile.
 *
 * @param username - Target player.
 * @param days - Lookback window (default 30, max 365).
 * @param timeZone - IANA timezone for day bucketing. Defaults to the
 *   browser's resolved timezone.
 */
export function getPublicScoreHistory(
  username: string,
  days: number = 30,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<{ history: UserScoreHistoryDay[] }> {
  const sp = new URLSearchParams({ days: String(days) });
  if (timeZone) sp.set("tz", timeZone);
  return request<{ history: UserScoreHistoryDay[] }>(
    `/player/${encodeURIComponent(username)}/score-history?${sp.toString()}`,
  );
}

/**
 * Fetch paginated game history for a public player profile (date-only).
 *
 * @param username - Target player.
 * @param limit - Max entries (default 20, max 100).
 * @param offset - Pagination offset (default 0).
 * @param timeZone - IANA timezone for the `playedDate` field. Defaults to
 *   the browser's resolved timezone so dates match the viewer's local
 *   calendar.
 */
export function getPublicGameHistory(
  username: string,
  limit: number = 20,
  offset: number = 0,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<{ entries: PublicGameHistoryEntry[]; total: number }> {
  const sp = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (timeZone) sp.set("tz", timeZone);
  return request<{ entries: PublicGameHistoryEntry[]; total: number }>(
    `/player/${encodeURIComponent(username)}/history?${sp.toString()}`,
  );
}

/**
 * Mint a lobby-invite token for a multiplayer room. The host calls this when
 * opening the share modal; the returned URL embeds an opaque token so the
 * server can attribute joiners back to the inviter on the socket join_room
 * event. Falls back gracefully on the caller side if the network fails — a
 * plain `/{roomCode}` URL still works (without attribution).
 *
 * @param roomCode 4-char room code (uppercase).
 * @param playerToken The host's mp_players.token, returned by createRoom.
 */
export function mintInviteToken(
  roomCode: string,
  playerToken: string,
): Promise<{ token: string; url: string }> {
  return request<{ token: string; url: string }>(
    `/mp/rooms/${encodeURIComponent(roomCode)}/invite-token`,
    {
      method: "POST",
      body: JSON.stringify({ playerToken }),
    },
  );
}
