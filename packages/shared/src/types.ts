import type { AVATARS, CATEGORIES } from "./constants.js";
import type { SharedRoundSnapshot } from "./shareGrid.js";

// === Game Types ===

export type GameMode = "classic" | "higher-lower" | "comparison" | "closest-without-going-over" | "price-match" | "riser" | "odd-one-out" | "market-basket" | "sort-it-out" | "budget-builder" | "chain-reaction" | "bidding";

export type BotDifficulty = "easy" | "medium" | "hard";

export interface Product {
  id: number;
  title: string;
  imageUrl: string;
  description: string;
  category: string;
  amazonUrl?: string;
  priceRange?: { min: number; max: number };
}

export interface ProductWithPrice extends Product {
  priceCents: number;
}

export interface GameSession {
  id: string;
  currentRound: number;
  totalRounds: number;
  totalScore: number;
  completed: boolean;
  gameMode: GameMode;
}

// Classic mode result
export interface RoundResult {
  product: ProductWithPrice;
  guessedPriceCents: number;
  score: number;
  pctOff: number;
}

export interface GuessResponse {
  result: RoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Higher/Lower mode
export interface HigherLowerRoundResult {
  product: ProductWithPrice;
  referencePrice: number;
  guess: "higher" | "lower";
  correct: boolean;
  score: number;
}

export interface HigherLowerGuessResponse {
  result: HigherLowerRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Comparison mode
export interface ComparisonRoundResult {
  products: ProductWithPrice[];
  question: "most-expensive" | "least-expensive";
  correctProductId: number;
  guessedProductId: number;
  correct: boolean;
  score: number;
}

export interface ComparisonGuessResponse {
  result: ComparisonRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Closest without going over mode
export interface ClosestRoundResult {
  product: ProductWithPrice;
  guessedPriceCents: number;
  score: number;
  pctOff: number;
  wentOver: boolean;
}

export interface ClosestGuessResponse {
  result: ClosestRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Price Match mode
export interface PriceMatchRoundResult {
  products: ProductWithPrice[];
  assignments: Record<number, number>; // productId -> guessedPriceCents
  correctCount: number;
  score: number;
}

export interface PriceMatchGuessResponse {
  result: PriceMatchRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Riser mode
export interface RiserRoundResult {
  product: ProductWithPrice;
  stoppedPriceCents: number;
  maxPriceCents: number;
  score: number;
  pctOff: number;
  wentOver: boolean;
}

export interface RiserGuessResponse {
  result: RiserRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Odd One Out mode
export interface OddOneOutRoundResult {
  products: ProductWithPrice[];
  outlierProductId: number;
  guessedProductId: number;
  correct: boolean;
  score: number;
}

export interface OddOneOutGuessResponse {
  result: OddOneOutRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Market Basket mode
export interface MarketBasketRoundResult {
  products: ProductWithPrice[];
  actualTotalCents: number;
  guessedTotalCents: number;
  pctOff: number;
  score: number;
}

export interface MarketBasketGuessResponse {
  result: MarketBasketRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Sort It Out mode
export interface SortItOutRoundResult {
  products: ProductWithPrice[];
  correctOrder: number[];
  submittedOrder: number[];
  correctCount: number;
  score: number;
}

export interface SortItOutGuessResponse {
  result: SortItOutRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Budget Builder mode
export interface BudgetBuilderRoundResult {
  products: ProductWithPrice[];
  budgetCents: number;
  selectedProductIds: number[];
  cartTotalCents: number;
  score: number;
}

export interface BudgetBuilderGuessResponse {
  result: BudgetBuilderRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// Chain Reaction mode
export interface ChainReactionRoundResult {
  products: ProductWithPrice[];
  chainGuesses: ("more" | "less")[];
  correctCount: number;
  chainLength: number;
  score: number;
}

export interface ChainReactionGuessResponse {
  result: ChainReactionRoundResult;
  session: GameSession;
  daily?: DailyCompletionPayload;
}

// === Multiplayer Types ===

export type Avatar = (typeof AVATARS)[number];

export type RoomStatus = "lobby" | "playing" | "ending" | "between_rounds" | "finished";

export interface MultiplayerPlayer {
  id: string;
  displayName: string;
  avatar: Avatar;
  isHost: boolean;
  isConnected: boolean;
  totalScore: number;
  isBot: boolean;
}

export interface MultiplayerRoom {
  code: string;
  gameMode: GameMode;
  categories: string[] | null;
  hasPassword: boolean;
  status: RoomStatus;
  currentRound: number;
  totalRounds: number;
  players: MultiplayerPlayer[];
  hostPlayerId: string;
  isPublic: boolean;
  botCount: number;
  botDifficulty: BotDifficulty;
  /**
   * Daily-challenge routing. When true, the room was created via the
   * daily-bidding quickplay flow: products come from that date's
   * `daily_puzzles` entry, matchmaking is scoped to other daily rooms of
   * the same date, and game end writes a `daily_plays` row + updates streak.
   */
  isDailyGame?: boolean;
  /** YYYY-MM-DD UTC date the daily room is scoped to (set only when `isDailyGame`). */
  dailyDate?: string;
  /**
   * ISO timestamp when the auto-lobby pre-game countdown will fire. Present
   * only on auto-lobbies after the first real human has joined and only
   * while the room is still in `lobby` status. Clients render this as a
   * "Starting in 0:32" banner; the real round-start signal still arrives via
   * `GAME_ROUND_START`, this is purely a display hint.
   */
  countdownTargetAt?: string;
}

/** Entry for the public lobby browser. */
export interface PublicLobbyEntry {
  code: string;
  hostName: string;
  hostAvatar: Avatar | null;
  gameMode: GameMode;
  playerCount: number;
  humanCount: number;
  botCount: number;
  maxPlayers: number;
  totalRounds: number;
  hasPassword: boolean;
}

export interface RoundStartPayload {
  roundNumber: number;
  gameMode: GameMode;
  timerSeconds: number;
  product?: Product & { priceRange?: { min: number; max: number } };
  products?: (Product & { priceRange?: { min: number; max: number } })[];
  referencePrice?: number;
  question?: string;
  prices?: number[];
  maxPriceCents?: number;
  speedPattern?: string;
  durationMs?: number;
  budgetCents?: number;
  /** Bidding mode: randomized turn order for this round */
  biddingOrder?: Array<{ playerId: string; displayName: string; avatar: string }>;
}

export interface PlayerRoundResult {
  playerId: string;
  displayName: string;
  avatar: Avatar;
  score: number;
  guessData: GuessData | null;
}

export interface RoundResultsPayload {
  roundNumber: number;
  gameMode: GameMode;
  revealData: RevealData;
  playerResults: PlayerRoundResult[];
  standings: { playerId: string; displayName: string; avatar: Avatar; totalScore: number }[];
}

/** Per-mode guess data submitted by players */
export type GuessData =
  | { guessedPriceCents: number }
  | { guess: "higher" | "lower" }
  | { guessedProductId: number }
  | { assignments: Record<string, number> }
  | { stoppedPriceCents: number }
  | { guessedTotalCents: number }
  | { submittedOrder: number[] }
  | { selectedProductIds: number[] }
  | { chainGuesses: ("more" | "less")[] }
  | { bidCents: number }
  | { timedOut: true };

/** Per-mode reveal data shown after round ends */
export type RevealData =
  | { mode: "classic"; product: ProductWithPrice }
  | { mode: "higher-lower"; product: ProductWithPrice; referencePrice: number }
  | { mode: "comparison"; products: ProductWithPrice[]; question: string; correctProductId: number }
  | { mode: "closest-without-going-over"; product: ProductWithPrice }
  | { mode: "price-match"; products: ProductWithPrice[] }
  | { mode: "riser"; product: ProductWithPrice; maxPriceCents: number }
  | { mode: "odd-one-out"; products: ProductWithPrice[]; outlierProductId: number }
  | { mode: "market-basket"; products: ProductWithPrice[]; actualTotalCents: number }
  | { mode: "sort-it-out"; products: ProductWithPrice[]; correctOrder: number[] }
  | { mode: "budget-builder"; products: ProductWithPrice[]; budgetCents: number }
  | { mode: "chain-reaction"; products: ProductWithPrice[] }
  | { mode: "bidding"; product: ProductWithPrice; bids: Array<{ playerId: string; displayName: string; bidCents: number }> };

/** Payload for game:bidding_turn event — signals whose turn it is to bid */
export interface BiddingTurnPayload {
  currentPlayerId: string;
  turnIndex: number;
  totalPlayers: number;
  timerSeconds: number;
  previousBids: Array<{ playerId: string; displayName: string; avatar: string; bidCents: number }>;
}

/** Payload for game:bid_placed event — broadcasts each player's bid */
export interface BidPlacedPayload {
  playerId: string;
  displayName: string;
  avatar: string;
  bidCents: number;
  turnIndex: number;
}

export interface MPLeaderboardEntry {
  rank: number;
  playerName: string;
  score: number;
  placement: number;
  playersCount: number;
  gameMode: string;
  playedAt: string;
}

// === Lobby Invite Rewards (multiplayer-only, separate from signup referrals) ===

/** Source of a pending score buff. `invite_host` is awarded to the inviter
 *  when their lobby link is used by a qualifying joiner; `invite_joiner` is
 *  the smaller welcome bonus for the joiner. `public_game` is awarded to
 *  every human player who finishes a publicly-listed lobby. Other sources
 *  may be added later (e.g. idle-economy "Rush" buff) — the consumer is
 *  the same. */
export type BuffSource = "invite_host" | "invite_joiner" | "public_game";

/** A single outstanding score buff held by one beneficiary. The score path
 *  consumes the highest-multiplier active buff per match (no stacking). */
export interface PendingBuff {
  id: number;
  source: BuffSource;
  multiplier: number;
  matchesRemaining: number;
  expiresAt: number; // unix seconds
  createdAt: number;
}

/** Why an invite attribution was rejected. Surfaced only in admin/analytics —
 *  the joiner is never told. */
export type InviteRejectReason =
  | "ip_collision"
  | "new_account"
  | "pair_dedup"
  | "cap_daily"
  | "cap_weekly"
  | "ip_throttle"
  | "kicked"
  | "unknown_token"
  | "self_invite";

/** Status of a single attribution row. `pending` means a joiner came in via a
 *  valid token but hasn't yet completed enough rounds to earn the reward;
 *  `earned` is terminal-success; `rejected` is terminal-fail (silent). */
export type InviteAttributionStatus = "pending" | "earned" | "rejected" | "kicked";

/** Server response when the host mints an invite token for the lobby share modal. */
export interface MintInviteTokenResponse {
  token: string;
  /** Fully-qualified URL (with host) the client can copy/share. */
  url: string;
}

/** Socket event emitted to the inviter when their reward is earned. */
export interface InviteRewardEarnedEvent {
  source: "invite_host";
  multiplier: number;
  matchesRemaining: number;
  /** Display name of the joiner who triggered the earn (for the toast copy). */
  joinerDisplayName: string;
}

/** Socket event emitted to the joiner with their welcome bonus. */
export interface InviteWelcomeBonusEvent {
  source: "invite_joiner";
  multiplier: number;
  matchesRemaining: number;
}

/** Socket event emitted when a buff is consumed during round scoring. */
export interface InviteBuffConsumedEvent {
  source: BuffSource;
  multiplier: number;
  matchesRemaining: number;
  rawScore: number;
  finalScore: number;
  /** Room the buff was consumed in — used by clients to cache events
   *  per-match while the listener lives at the global App level. */
  roomCode: string;
}

/** Client-side struct used by the lobby share modal — what to show + share. */
export interface LobbyShareInput {
  roomCode: string;
  inviteUrl: string;
  modeName: string;
}

export type Category = (typeof CATEGORIES)[number];

// === Admin Types ===

export interface AdminUser {
  id: string;
  username: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  isActive: boolean;
  canUseExtension: boolean;
  totpEnabled: boolean;
}

export interface AdminLoginRequest {
  username: string;
  password: string;
}

export interface AdminLoginResponse {
  user: AdminUser;
  requiresTwoFactor?: boolean;
  pendingToken?: string;
  /**
   * True when the server is running with `SKIP_ADMIN_2FA=1` (sandbox/dev
   * environments). Signals the web client to skip the normally-mandatory
   * 2FA enrollment redirect. Never set in production deployments.
   */
  skip2fa?: boolean;
}

export interface AdminMeResponse {
  user: AdminUser;
  /** See {@link AdminLoginResponse.skip2fa}. */
  skip2fa?: boolean;
}

// === Admin 2FA Types ===

export interface Admin2faSetupResponse {
  secret: string;
  otpauthUri: string;
  qrCodeDataUrl: string;
}

export interface Admin2faVerifyEnableResponse {
  recoveryCodes: string[];
}

export interface Admin2faStatusResponse {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
}

export interface Admin2faVerifyLoginRequest {
  pendingToken: string;
  code: string;
  isRecoveryCode?: boolean;
}

export interface Admin2faVerifyLoginResponse {
  user: AdminUser;
}

export interface Admin2faDisableRequest {
  password: string;
  code: string;
  isRecoveryCode?: boolean;
}

export interface Admin2faRegenerateCodesRequest {
  password: string;
}

export interface Admin2faRegenerateCodesResponse {
  recoveryCodes: string[];
}

// === User Account Types ===

export interface UserAccount {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  isActive: boolean;
  lifetimeScore: number;
  usernamePending: boolean;
  referralCode: string;
  avatar: Avatar | null;
}

export interface UserLoginRequest {
  identifier: string;  // email or username
  password: string;
  /**
   * When true (or omitted, for backwards compatibility with pre-flag
   * clients), the server sets a persistent cookie with the full session
   * duration. When false, the server sets a browser-session cookie
   * (deleted on browser close) backed by a short-lived DB session.
   */
  stayLoggedIn?: boolean;
}

export interface UserLoginResponse {
  user: UserAccount;
}

export interface UserMeResponse {
  user: UserAccount | null;
}

export interface UserRegisterRequest {
  username: string;
  email: string;
  password: string;
  referralCode?: string;
  turnstileToken?: string;
}

// === Referral Types ===

export type ReferralStatus = "pending" | "credited" | "rejected";

export interface ReferralEntry {
  id: string;
  referredUsername: string;
  referredAvatar: Avatar | null;
  status: ReferralStatus;
  rejectionReason: string | null;
  createdAt: string;
  creditedAt: string | null;
}

export interface ReferralDashboard {
  referralCode: string;
  referralUrl: string;
  totalReferrals: number;
  creditedReferrals: number;
  pendingReferrals: number;
  referrals: ReferralEntry[];
  multiAccountWarning: boolean;
}

export interface UserRegisterResponse {
  user: UserAccount;
  emailVerificationPending: boolean;
}

export interface GameHistoryEntry {
  id: number;
  gameType: "single" | "multiplayer";
  gameMode: string;
  score: number;
  placement: number | null;
  playersCount: number | null;
  playedAt: string;
  shareId?: string | null;
}

export interface UserStats {
  totalGames: number;
  totalScore: number;
  bestScore: number;
  averageScore: number;
  gamesByMode: Record<string, number>;
  multiplayerWins: number;
}

/** Daily score aggregate for a user's score history chart. */
export interface UserScoreHistoryDay {
  date: string;
  totalScore: number;
  gamesPlayed: number;
}

/** V2 leaderboard entry: lifetime score-based, registered users only. */
export interface LifetimeLeaderboardEntry {
  rank: number;
  username: string;
  lifetimeScore: number;
  totalGames: number;
  avatar: Avatar | null;
}

/** Longest-streak leaderboard entry: top players by daily-challenge streak. */
export interface LongestStreakLeaderboardEntry {
  rank: number;
  username: string;
  avatar: Avatar | null;
  longestStreak: number;
  currentStreak: number;
}

/**
 * Time-window filter for the score leaderboard. Rolling windows:
 * day = last 24h, week = last 7d, month = last 30d, all = no cutoff.
 */
export type LeaderboardPeriod = "day" | "week" | "month" | "all";

/**
 * Game-type filter for the score leaderboard.
 *  - "all" — combined single-player + multiplayer (default; current behavior).
 *  - "sp"  — single-player only (`user_game_history` rows where `game_type = 'single'`).
 *  - "mp"  — multiplayer only (`user_game_history` rows where `game_type = 'multiplayer'`).
 */
export type LeaderboardGameType = "all" | "sp" | "mp";

/** Score leaderboard entry for a bounded time window. */
export interface PeriodLeaderboardEntry {
  rank: number;
  username: string;
  avatar: Avatar | null;
  /** Points earned within the selected period. */
  score: number;
  /** Games played within the selected period. */
  totalGames: number;
}

/**
 * Drives leaderboard-page pill visibility — periods with no scoring players
 * are hidden. The bounded windows are existence flags (0 or 1) computed via
 * indexed `EXISTS` checks; only the `all` field carries a real player
 * count, used for the lifetime board's "N players" caption. The bounded
 * fields used to be true counts but are no longer — see `getLeaderboardAvailability`
 * in apps/server/src/services/publicProfile.ts for the perf reasoning.
 */
export interface LeaderboardAvailability {
  /** 1 if any non-excluded player scored in the last 24h, else 0. */
  day: number;
  /** 1 if any non-excluded player scored in the last 7d, else 0. */
  week: number;
  /** 1 if any non-excluded player scored in the last 30d, else 0. */
  month: number;
  /** Real count of players with `lifetime_score > 0`. */
  all: number;
}

/** Public player profile summary (no auth required). */
export interface PublicPlayerProfile {
  username: string;
  avatar: Avatar | null;
  lifetimeScore: number;
  totalGames: number;
  bestScore: number;
  averageScore: number;
  gamesByMode: Record<string, number>;
  multiplayerWins: number;
  memberSince: string;
  /** Lifetime W/L/Streak snapshot (cached on `users`). Optional for
   *  backward-compat with serialized fixtures and any pre-v69 cached
   *  responses; the server always returns it for fresh requests. Ghost
   *  profiles return zeros — ghosts don't track W/L. */
  winRecord?: {
    wins: number;
    losses: number;
    currentStreak: number;
    bestStreak: number;
  };
}

/** Public game history entry with date-only (no timestamps). */
export interface PublicGameHistoryEntry {
  id: number;
  gameType: "single" | "multiplayer";
  gameMode: string;
  score: number;
  placement: number | null;
  playersCount: number | null;
  playedDate: string;
  /** Share record ID, if this game was shared. Links to /s/:shareId. */
  shareId: string | null;
}

/** Rank response for a logged-in user after a game. */
export interface UserRankResponse {
  rank: number;
  totalPlayers: number;
  /** All-time best (lowest) rank achieved, or null if no history yet. */
  bestRank: number | null;
}

/** Daily rank snapshot for the rank-over-time chart. */
export interface UserRankHistoryDay {
  date: string;
  rank: number;
  totalPlayers: number;
}

export interface UserUpdateEmailRequest {
  newEmail: string;
  password: string;
}

export interface UserUpdatePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

// === Site Settings Types ===

/** Game mode enable/disable settings returned by the admin API. */
export interface GameModeSettings {
  /** All available game modes with metadata. */
  modes: { mode: string; name: string; description: string }[];
  /** Modes that are currently disabled by an admin. */
  disabledModes: string[];
}

/**
 * How a player qualifies for a reward / the monthly giveaway.
 *
 * - `points_only`       — meet `minPoints` threshold (default, backwards compatible)
 * - `streak_only`       — meet `minStreak` active daily-challenge streak
 * - `points_and_streak` — must meet both thresholds
 * - `points_or_streak`  — meeting either threshold is enough
 */
export type QualificationMode =
  | "points_only"
  | "streak_only"
  | "points_and_streak"
  | "points_or_streak";

/** Promo banner configuration. */
export interface PromoBanner {
  enabled: boolean;
  text: string;
  linkText: string;
  linkUrl: string;
  /** Who sees the banner: 'all' = everyone, 'logged_in' = authenticated users only. */
  audienceMode: "all" | "logged_in";
  /** Whether to show the link button. */
  showLink: boolean;
  /** Whether to show a "Giveaway Details" button that opens the rules modal. */
  showGiveawayModal: boolean;
  /** Minimum points required to qualify for the monthly giveaway drawing. */
  giveawayMinPoints: number;
  /** Minimum current daily-challenge streak required to qualify. 0 disables. */
  giveawayMinStreak: number;
  /** How the giveaway's points/streak thresholds combine. */
  giveawayQualifyMode: QualificationMode;
  /** Whether to show the monthly points progress tracker inside the banner. */
  showTracker: boolean;
  /** Custom message shown to qualified users in the progress tracker. Supports {month} placeholder. */
  qualifiedMessage: string;
}

// === Analytics Types ===

export interface AnalyticsOverview {
  totalGames: number;
  totalGamesStarted: number;
  gamesLast24h: number;
  gamesLast7d: number;
  activeRoomsCount: number;
  avgScore: number;
  totalPlayers: number;
}

export interface AnalyticsGamesByDay {
  date: string;
  count: number;
  spTotal: number;
  spCompleted: number;
  mpTotal: number;
  mpCompleted: number;
}

export interface AnalyticsGamesByMode {
  mode: string;
  count: number;
  completed: number;
  inProgress: number;
  abandoned: number;
}

export interface AnalyticsPlayerActivity {
  date: string;
  uniquePlayers: number;
}

export interface AnalyticsCategoryStats {
  category: string;
  roundsPlayed: number;
}

export interface AnalyticsActiveRoom {
  code: string;
  gameMode: string;
  status: string;
  playerCount: number;
  currentRound: number;
  totalRounds: number;
  createdAt: string;
}

export interface AnalyticsScoreDistribution {
  bucket: string;
  count: number;
}

// === Admin Product Management Types ===

/** Full product row for admin dashboard. */
export interface AdminProduct {
  id: number;
  asin: string | null;
  title: string;
  imageUrl: string | null;
  description: string | null;
  priceCents: number;
  category: string | null;
  isActive: boolean;
  isArchived: boolean;
  manufacturer: string | null;
  lastUsedAt: string | null;
  scrapedAt: string | null;
  addedAt: string | null;
  verified: boolean;
}

/** Query parameters for listing admin products. */
export interface AdminProductListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
  isActive?: boolean;
  isArchived?: boolean;
  sortBy?: "id" | "title" | "priceCents" | "category" | "manufacturer" | "addedAt";
  sortOrder?: "asc" | "desc";
}

/** Paginated response for admin product listing. */
export interface AdminProductListResponse {
  products: AdminProduct[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Request body for bulk-updating product active status. */
export interface AdminBulkStatusRequest {
  ids: number[];
  isActive: boolean;
}

/** Response for bulk status update. */
export interface AdminBulkStatusResponse {
  updated: number;
}

/** Request body for bulk-archiving products. */
export interface AdminBulkArchiveRequest {
  ids: number[];
  isArchived: boolean;
}

/** Response for bulk archive update. */
export interface AdminBulkArchiveResponse {
  updated: number;
}

/** Request body for creating a new product. */
export interface AdminProductCreateRequest {
  title: string;
  priceCents: number;
  asin?: string;
  imageUrl?: string;
  description?: string;
  category?: string;
  manufacturer?: string;
  isActive?: boolean;
}

/** Request body for updating a product (all fields optional). */
export interface AdminProductUpdateRequest {
  title?: string;
  priceCents?: number;
  asin?: string;
  imageUrl?: string;
  description?: string;
  category?: string;
  manufacturer?: string;
  isActive?: boolean;
}

// === Admin Manufacturer Contact Types ===

/** Manufacturer record from the contacts database. */
export interface AdminManufacturer {
  id: number;
  name: string;
  website: string | null;
  productCount: number;
  searchStatus: string;
}

/** Valid contact type values. */
export type AdminContactType = "media" | "promotions" | "pr" | "partnerships" | "general" | "support";

/** Valid confidence level values. */
export type AdminConfidence = "high" | "medium" | "low";

/** Contact record from the contacts database. */
export interface AdminContact {
  id: number;
  manufacturerId: number;
  contactType: AdminContactType;
  email: string | null;
  phone: string | null;
  contactPageUrl: string | null;
  sourceUrl: string | null;
  confidence: AdminConfidence;
  notes: string | null;
  verifiedAt: string | null;
}

/** Manufacturer with its associated contacts. */
export interface AdminManufacturerWithContacts {
  manufacturer: AdminManufacturer;
  contacts: AdminContact[];
}

/** Request body for creating a contact. */
export interface AdminContactCreateRequest {
  contactType: AdminContactType;
  email?: string;
  phone?: string;
  contactPageUrl?: string;
  sourceUrl?: string;
  confidence: AdminConfidence;
  notes?: string;
}

/** Request body for updating a contact (all fields optional). */
export interface AdminContactUpdateRequest {
  contactType?: AdminContactType;
  email?: string;
  phone?: string;
  contactPageUrl?: string;
  sourceUrl?: string;
  confidence?: AdminConfidence;
  notes?: string;
}

// === Chrome Extension Import Types ===

/** Request body for importing a product via the Chrome extension. */
export interface ExtensionImportRequest {
  asin: string;
  title: string;
  priceCents: number;
  imageUrl?: string;
  description?: string;
  category?: string;
  manufacturer?: string;
}

/** Response body for a Chrome extension product import. */
export interface ExtensionImportResponse {
  product: AdminProduct;
  created: boolean;
}

/** Response body for Chrome extension login (returns token in body, no cookie). */
export interface ExtensionLoginResponse {
  token: string;
  user: AdminUser;
}

// === Product Universe Types ===

/** Confidence level for data sourcing. */
export type PUConfidence = "high" | "medium" | "low";

/** Supply chain node type. */
export type PUNodeType = "raw_material" | "processing" | "manufacturing" | "assembly" | "distribution" | "retail";

/** Corporate relationship type. */
export type PURelationshipType = "parent" | "subsidiary" | "supplier" | "joint_venture" | "acquired" | "partner";

/** Company role relative to a product. */
export type PUCompanyRole = "manufacturer" | "brand_owner" | "distributor" | "supplier" | "designer";

/** Enrichment job type. */
export type PUJobType = "search" | "extract" | "enrich_materials" | "enrich_supply_chain" | "enrich_company" | "enrich_history" | "compute_similarity";

/** Enrichment job status. */
export type PUJobStatus = "pending" | "running" | "completed" | "failed";

/** A material used in a product. */
export interface PUMaterial {
  id: number;
  name: string;
  category: string | null;
  description: string | null;
  sustainabilityScore: number | null;
  createdAt: string;
}

/** Link between a product and a material. */
export interface PUProductMaterial {
  productId: number;
  materialId: number;
  percentage: number | null;
  confidence: PUConfidence;
  sourceId: number | null;
}

/** A company in the knowledge graph. */
export interface PUCompany {
  id: number;
  name: string;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
  foundedYear: number | null;
  headquarters: string | null;
  employeeCount: number | null;
  revenue: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A geographic location. */
export interface PULocation {
  id: number;
  name: string;
  country: string;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  locationType: string | null;
}

/** A node in the supply chain graph. */
export interface PUSupplyChainNode {
  id: number;
  productId: number;
  nodeType: PUNodeType;
  companyId: number | null;
  locationId: number | null;
  description: string | null;
  orderIndex: number;
  confidence: PUConfidence;
  sourceId: number | null;
}

/** Relationship between two companies. */
export interface PUCompanyRelationship {
  id: number;
  companyId: number;
  relatedCompanyId: number;
  relationshipType: PURelationshipType;
  confidence: PUConfidence;
  sourceId: number | null;
}

/** Link between a product and a company. */
export interface PUProductCompany {
  productId: number;
  companyId: number;
  role: PUCompanyRole;
  confidence: PUConfidence;
  sourceId: number | null;
}

/** Precomputed similarity score between two products. */
export interface PUProductSimilarity {
  productIdA: number;
  productIdB: number;
  score: number;
  reason: string | null;
}

/** 3D position for galaxy visualization. */
export interface PUGalaxyPosition {
  productId: number;
  x: number;
  y: number;
  z: number;
  cluster: number | null;
}

/** A data source reference. */
export interface PUSource {
  id: number;
  url: string;
  title: string | null;
  fetchedAt: string;
  contentHash: string | null;
}

/** An enrichment job record. */
export interface PUEnrichmentJob {
  id: number;
  productId: number | null;
  companyId: number | null;
  jobType: PUJobType;
  status: PUJobStatus;
  priority: number;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Cached web search result. */
export interface PUSearchCache {
  id: number;
  query: string;
  resultJson: string;
  cachedAt: string;
  expiresAt: string;
}

/** Link between a material and a sourcing location. */
export interface PUMaterialLocation {
  id: number;
  materialId: number;
  locationId: number;
  role: string | null;
  confidence: PUConfidence;
  sourceId: number | null;
}

/** AI-generated summary card for a product. */
export interface PUSummaryCard {
  title: string;
  content: string;
  category: "overview" | "materials" | "supply_chain" | "company" | "sustainability" | "history";
  icon: string;
  sources?: PUSource[];
}

/** Material data hydrated with source information. */
export interface PUMaterialWithSource {
  name: string;
  category: string | null;
  description: string | null;
  percentage: number | null;
  confidence: PUConfidence;
  source?: PUSource | null;
}

/** Full product detail with enrichment data. */
export interface PUProductDetail {
  id: number;
  title: string;
  imageUrl: string | null;
  description: string | null;
  priceCents: number;
  category: string | null;
  manufacturer: string | null;
  puEnriched: boolean;
  puEnrichedAt: string | null;
  puSummary: string | null;
  puHistory: string | null;
  materials: PUProductMaterial[];
  companies: (PUProductCompany & { company: PUCompany })[];
  supplyChain: (PUSupplyChainNode & { company?: PUCompany; location?: PULocation })[];
  sources?: PUSource[];
}

/** Galaxy node for 3D visualization. */
export interface PUGalaxyNode {
  productId: number;
  title: string;
  category: string | null;
  x: number;
  y: number;
  z: number;
  cluster: number | null;
  enriched: boolean;
}

/** Company with relationship info for graph visualization. */
export interface PUCompanyWithRelationships extends PUCompany {
  relationships: (PUCompanyRelationship & { relatedCompany: PUCompany })[];
  products: { id: number; title: string; role: PUCompanyRole }[];
}

/** Search result from /api/pu/search. */
export interface PUSearchResult {
  products: {
    id: number;
    title: string;
    imageUrl: string | null;
    category: string | null;
    manufacturer: string | null;
    enriched: boolean;
  }[];
  total: number;
  enrichmentTriggered: boolean;
}

// === Rewards System Types ===

/** Status of a reward in the pool. */
export type RewardStatus = "available" | "awarded" | "claimed";

/** Method used to award a reward. */
export type RewardAwardMethod = "manual" | "random_roll";

/** A reward item in the admin reward pool. */
export interface Reward {
  id: string;
  rewardType: string;
  amountCents: number;
  code: string;
  description: string | null;
  status: RewardStatus;
  createdAt: string;
  createdBy: string;
  /** Populated when status is 'awarded' or 'claimed'. */
  award?: RewardAwardSummary | null;
}

/** Summary of how a reward was awarded. */
export interface RewardAwardSummary {
  id: string;
  userId: string;
  username: string;
  awardMethod: RewardAwardMethod;
  awardCriteria: string | null;
  awardedAt: string;
  awardedBy: string;
  claimedAt: string | null;
  /**
   * Deadline (ISO timestamp) by which the user must claim. After this point
   * the sweeper voids the award and returns the reward to the pool.
   * For pending-review rows, this is a placeholder — the real window
   * starts when an admin confirms the award.
   */
  claimExpiresAt: string;
  /** Set when the sweeper voids an unclaimed award past its deadline. */
  voidedAt: string | null;
  /**
   * When non-null, a random roll has selected this user as a candidate but
   * the admin has not yet confirmed the award. No emails have been sent
   * and the claim window has not started. Cleared by confirmPendingAward
   * (or the row is deleted by discardPendingAward).
   */
  pendingReviewAt: string | null;
}

/** Paginated response for the admin reward listing. */
export interface RewardListResponse {
  rewards: Reward[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Query params for listing rewards. */
export interface RewardListParams {
  page?: number;
  pageSize?: number;
  status?: RewardStatus | "all";
}

/** Request body for adding a reward to the pool. */
export interface RewardCreateRequest {
  rewardType: string;
  amountCents: number;
  code: string;
  description?: string;
}

/** Request body for manually awarding a reward. */
export interface RewardAwardRequest {
  userId: string;
}

/** Criteria for qualifying players in a random roll. */
export interface RandomRollCriteria {
  /**
   * How the points and streak thresholds combine to qualify a player.
   * Optional — defaults to "points_only" (legacy behavior) when omitted.
   */
  mode?: QualificationMode;
  /** Minimum points scored in the given time period. Ignored when mode is "streak_only". */
  minPoints: number;
  /**
   * Time period:
   *  - `last_week | last_month | last_3_months` — rolling window from now
   *  - `all_time` — full history
   *  - `calendar_month` — a specific calendar month (provide `month` field)
   */
  period: "last_week" | "last_month" | "last_3_months" | "all_time" | "calendar_month";
  /**
   * Required when `period === "calendar_month"`. Identifies which calendar
   * month qualifies — e.g. `{ year: 2026, monthIndex: 3 }` for April 2026.
   * `monthIndex` is 0-indexed (Jan=0) to match JavaScript Date semantics.
   */
  month?: { year: number; monthIndex: number };
  /** Whether to use total lifetime points instead of period-based points. */
  useLifetimePoints: boolean;
  /** Minimum current daily-challenge streak required. Ignored when mode is "points_only". Defaults to 0. */
  minStreak?: number;
  /**
   * Optional list of user IDs to exclude from the qualifying pool. Used by
   * the admin UI to drop test accounts, friends/family, or any specific
   * user before rolling. Test accounts (`is_test_account = 1`) are excluded
   * automatically by default — see `excludeTestAccounts`.
   */
  excludedUserIds?: string[];
  /**
   * If true (default), users flagged `is_test_account` are dropped from the
   * pool before any roll or preview. Set false only if the admin
   * deliberately wants to include test accounts (e.g. to demo the flow).
   */
  excludeTestAccounts?: boolean;
}

/** A player who qualifies for a random roll. */
export interface QualifyingPlayer {
  id: string;
  username: string;
  email: string;
  points: number;
  gamesPlayed: number;
  /** Current active daily-challenge streak (decayed if stale). */
  streak: number;
}

/** Request body for executing a random roll. */
export interface RandomRollRequest {
  criteria: RandomRollCriteria;
  rewardId: string;
}

/** Response from a random roll. */
export interface RandomRollResponse {
  winner: QualifyingPlayer;
  reward: Reward;
  totalQualifying: number;
}

/** Response for qualifying players preview. */
export interface QualifyingPlayersResponse {
  players: QualifyingPlayer[];
  total: number;
}

/** A reward as seen by the user who received it. */
export interface UserReward {
  id: string;
  rewardType: string;
  amountCents: number;
  /** Masked code; the full code is only revealed by the claim endpoint. */
  code: string;
  description: string | null;
  awardMethod: RewardAwardMethod;
  awardedAt: string;
  claimedAt: string | null;
  /** Deadline by which the user must claim. */
  claimExpiresAt: string;
  /** Per-award token used by the email/settings claim deep link. */
  claimToken: string;
}

/** Public stats for the universe. */
export interface PUStats {
  totalProducts: number;
  enrichedProducts: number;
  totalMaterials: number;
  totalCompanies: number;
  totalLocations: number;
  totalSupplyChainNodes: number;
}

// === Admin Daily Drill-Down Types ===

/** A single game entry for the daily drill-down view. */
export interface AdminGamesForDateEntry {
  type: "singleplayer" | "multiplayer";
  id: string;
  gameMode: string;
  score: number | null;
  playerName: string | null;
  playersCount: number | null;
  completionStatus: "completed" | "in-progress" | "abandoned";
  startedAt: string;
  completedAt: string | null;
}

/** Response from the daily drill-down endpoint. */
export interface AdminGamesForDateResponse {
  date: string;
  singleplayer: AdminGamesForDateEntry[];
  multiplayer: AdminGamesForDateEntry[];
}

// === Admin User Analytics Types ===

/** Daily user registration count. */
export interface AdminUserRegistrationsDay {
  date: string;
  count: number;
}

/** User retention metrics. */
export interface AdminUserRetention {
  totalUsers: number;
  activeLastWeek: number;
  activeLastMonth: number;
  retentionRateWeek: number;
  retentionRateMonth: number;
}

/** Top player summary for admin dashboard. */
export interface AdminTopPlayer {
  id: string;
  username: string;
  lifetimeScore: number;
  totalGames: number;
}

// === Admin User Management Types ===

/** Query parameters for listing users in the admin panel. */
export interface AdminUserListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  isActive?: boolean;
  sortBy?: "username" | "email" | "created_at" | "lifetime_score" | "last_login_at" | "referrals";
  sortOrder?: "asc" | "desc";
}

/** Paginated response for admin user listing. */
export interface AdminUserListResponse {
  users: AdminUserSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Summary of a user for admin list views. */
export interface AdminUserSummary {
  id: string;
  username: string;
  email: string;
  avatar: Avatar | null;
  isActive: boolean;
  lifetimeScore: number;
  createdAt: string;
  lastLoginAt: string | null;
  totalGames: number;
  /** Number of referrals where this user is the referrer that reached `credited` status. */
  creditedReferrals: number;
  /** Total referrals where this user is the referrer (any status). */
  totalReferrals: number;
}

/** Detailed user info for the admin detail view. */
export interface AdminUserDetail extends AdminUserSummary {
  emailVerified: boolean;
  updatedAt: string;
  oauthProvider: string | null;
}

/** Request body for admin user updates. */
export interface AdminUserUpdateRequest {
  username?: string;
  email?: string;
  isActive?: boolean;
}

/** Paginated game history response for admin per-user view. */
export interface AdminUserGameHistoryResponse {
  history: GameHistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Daily activity count for a single user. */
export interface AdminUserActivityDay {
  date: string;
  gamesPlayed: number;
}

// === Admin Referral Analytics Types ===

/** Time-window selector for the referrals analytics endpoints. */
export type AdminReferralRange = "7d" | "28d" | "90d" | "all";

/** Aggregate KPIs for a referral analytics window. */
export interface AdminReferralSummary {
  /** All referrals (any status) created in the window. */
  total: number;
  credited: number;
  pending: number;
  rejected: number;
  /** credited / total, in [0, 1]. Zero when total is zero. */
  conversionRate: number;
  /** Distinct referrer users represented in the window. */
  uniqueReferrers: number;
  /** ISO timestamp of the start of the window (null when range is "all"). */
  periodStart: string | null;
  /** ISO timestamp at the moment the snapshot was computed. */
  periodEnd: string;
}

/** A single day in the daily-referrals time series. */
export interface AdminReferralDailyPoint {
  /** YYYY-MM-DD calendar day in the admin timezone. */
  date: string;
  /** Referrals created on this day (any status). */
  created: number;
  /** Referrals credited on this day (regardless of when created). */
  credited: number;
}

/** A row in the top-referrers leaderboard. */
export interface AdminReferralTopReferrer {
  userId: string;
  username: string;
  avatar: Avatar | null;
  credited: number;
  pending: number;
  rejected: number;
  total: number;
}

/** A bucket in the rejection-reason breakdown. */
export interface AdminReferralRejectionBucket {
  /** Rejection reason ("ip_match", "disposable_email", or "unknown"). */
  reason: string;
  count: number;
}

/** A user who was referred by a specific referrer (for the admin drill-down). */
export interface AdminReferredUser {
  /** ID of the referrals row (not the user). */
  referralId: string;
  /** ID of the referred user. */
  userId: string;
  username: string;
  avatar: Avatar | null;
  /** Status of the referral itself, not the user account. */
  status: "pending" | "credited" | "rejected";
  rejectionReason: string | null;
  /** ISO timestamp when the referral row was created (signup time). */
  createdAt: string;
  /** ISO timestamp when the referral was credited; null if not credited. */
  creditedAt: string | null;
}

// === Daily Challenge Mode ===

/** A row in the daily_puzzles cache; the canonical puzzle for a given UTC date. */
export interface DailyPuzzle {
  date: string;               // YYYY-MM-DD UTC
  gameMode: GameMode;
  totalRounds: number;        // always DAILY_TOTAL_ROUNDS in v1
  saltVersion: number;
  isManualOverride: boolean;
}

/** Public response for GET /api/daily/today. */
export interface DailyTodayResponse {
  date: string;
  gameMode: GameMode | null;  // null when every pool mode is disabled
  modeName: string;
  totalRounds: number;
  /** Server-checked for logged-in users; omitted for anonymous. */
  alreadyPlayed?: boolean;
  /** Streak snapshot for the requesting user, if logged in. */
  streak?: DailyStreak;
}

/** Streak snapshot for a single user. */
export interface DailyStreak {
  current: number;
  best: number;
  lastDate: string | null;
}

/** A single completed daily play (used in history responses and recap modal). */
export interface DailyPlay {
  date: string;
  gameMode: GameMode;
  score: number;
  completedAt: string;
  streakAtCompletion: number;
  perRoundScores: number[];
}

/** Response for GET /api/daily/history. */
export interface DailyHistoryResponse {
  plays: DailyPlay[];
}

/**
 * Response for GET /api/daily/recap/:date. Returned when an authenticated
 * user requests the recap for a daily they have already completed. Combines
 * their per-round scores with the full product data from the (deterministic,
 * shared-across-users) daily puzzle for that date so the client can render a
 * rich share card with product titles, thumbnails, and Amazon affiliate
 * links.
 */
export interface DailyRecapResponse {
  date: string;
  gameMode: GameMode;
  modeName: string;
  totalScore: number;
  perRoundMax: number;
  perRoundScores: number[];
  /**
   * Per-round snapshots in the exact shape ShareModal expects — reusing
   * {@link SharedRoundSnapshot} so the client can drop the array straight
   * into `<ShareModal roundSnapshots={...} />` without remapping.
   */
  rounds: SharedRoundSnapshot[];
}

/**
 * Augmentation included in the final-round guess response when the session
 * is a daily and the player is logged in. Lets the client show the streak
 * increment animation without a follow-up request.
 */
export interface DailyCompletionPayload {
  streak: DailyStreak;
  isNewBest: boolean;
  isNewStreak: boolean;
}

// --- Admin daily types ---

/** A single row in the admin's "upcoming puzzles" overview table. */
export interface AdminDailyPuzzleRow {
  date: string;
  gameMode: GameMode;
  productIds: number[];
  productTitles: string[];
  /** Parallel array of image URLs (empty string when the product has no image). */
  productImageUrls: string[];
  /** Parallel array of prices in cents. */
  productPriceCents: number[];
  isManualOverride: boolean;
  playCount: number;
  averageScore: number | null;
  /** ISO timestamp when the puzzle row was first cached, or null if previewed only. */
  cachedAt: string | null;
}

/** Response for GET /api/admin/daily/overview. */
export interface AdminDailyOverviewResponse {
  enabled: boolean;
  schedule: GameMode[]; // length 7, UTC day-of-week 0=Sun
  currentDate: string;
  rows: AdminDailyPuzzleRow[];
}

/** Body for PUT /api/admin/daily/schedule. */
export interface AdminDailyScheduleUpdate {
  schedule: GameMode[];
}

/** Body for PUT /api/admin/daily/:date/products. */
export interface AdminDailyProductsUpdate {
  gameMode: GameMode;
  productIds: number[];
}

/** Response for GET /api/admin/daily/stats. */
export interface AdminDailyStatsResponse {
  totalPlays: number;
  uniquePlayers: number;
  last30Days: Array<{ date: string; plays: number; averageScore: number }>;
  topStreaks: Array<{ username: string; currentStreak: number; bestStreak: number }>;
}

// === Push Notifications ===

/** Notification type identifier. */
export type NotificationType =
  | "daily_puzzle"
  | "streak_reminder"
  | "leaderboard_updates"
  | "leaderboard_placement"
  | "multiplayer_invites"
  | "promotional";

/** Browser PushSubscription.toJSON() shape sent from client to server. */
export interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** Per-user notification preference state. */
export interface NotificationPreferences {
  pushEnabled: boolean;
  dailyPuzzle: boolean;
  streakReminder: boolean;
  leaderboardUpdates: boolean;
  /** Opt-in push for landing on the top 3 of a daily/weekly/monthly board. */
  leaderboardPlacement: boolean;
  multiplayerInvites: boolean;
  promotional: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
}

/** Admin-managed notification template. */
export interface NotificationTemplate {
  id: number;
  name: string;
  type: NotificationType;
  titleTemplate: string;
  bodyTemplate: string;
  icon: string;
  urlPath: string;
  actionsJson: string | null;
  ttl: number;
  urgency: "very-low" | "low" | "normal" | "high";
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A single entry in the notification log (admin analytics). */
export interface NotificationLogEntry {
  id: number;
  userId: string;
  /**
   * Username of the recipient at log query time. Backfilled by a LEFT JOIN
   * on `users` so admins see human-readable identifiers in the log instead
   * of opaque user IDs. Defensively typed as nullable for the LEFT JOIN
   * shape; in practice the FK + ON DELETE CASCADE guarantees a user row
   * exists whenever a log row does.
   */
  username: string | null;
  subscriptionId: number | null;
  templateId: number | null;
  type: NotificationType;
  title: string | null;
  body: string | null;
  urlPath: string | null;
  status: "pending" | "sent" | "clicked" | "failed" | "expired" | "suppressed";
  httpStatus: number | null;
  errorMessage: string | null;
  /**
   * Free-form reason recorded when `status === 'suppressed'`. Examples:
   *   'already_played'  — the user completed today's daily before dispatch
   *   'streak_broken'   — the streak this reminder protected has already lapsed
   * The scheduler writes one of these whenever it drops a queued notification
   * at the last mile so the admin log carries an audit trail of "we tried
   * to send this and chose not to."
   */
  suppressionReason: string | null;
  sentAt: string | null;
  clickedAt: string | null;
  createdAt: string;
}

/** Payload shape for the NOTIFICATION_RECEIVED socket event. */
export interface NotificationReceivedPayload {
  type: NotificationType;
  title: string;
  body: string;
  url?: string;
  icon?: string;
}

/** Aggregate notification stats for admin dashboard. */
export interface NotificationStats {
  totalSubscribers: number;
  activeSubscribers: number;
  totalSent: number;
  totalClicked: number;
  deliveryRate: number;
  clickThroughRate: number;
  byType: Array<{
    type: NotificationType;
    sent: number;
    clicked: number;
    failed: number;
    ctr: number;
  }>;
}

// === Email Notifications (separate from push; coarser cadence, opt-in) ===

/**
 * Email notification type identifier. Distinct from push `NotificationType`
 * because email triggers are re-engagement oriented (inactivity, streak-at-risk
 * after a full day has passed, weekly digest) whereas push is mostly
 * same-day / instant.
 */
export type EmailNotificationType =
  | "streak_risk"
  | "streak_save"
  | "inactivity_reminder"
  | "weekly_digest"
  | "leaderboard_placement"
  | "promotional"
  | "giveaway_loss"
  | "custom";

/**
 * Per-user email preferences. All booleans default to `false` on account
 * creation — email is strictly opt-in, unlike push which defaults several
 * engagement types to on. The one exception is `giveawayLoss`, which
 * defaults to `true` because it is a transactional follow-up to a
 * giveaway the user already opted into by playing.
 */
export interface EmailPreferences {
  emailEnabled: boolean;
  streakRisk: boolean;
  streakSave: boolean;
  inactivityReminder: boolean;
  weeklyDigest: boolean;
  /** Opt-in email when landing on top 3 of a daily/weekly/monthly board. */
  leaderboardPlacement: boolean;
  promotional: boolean;
  /**
   * Default-on consolation email sent to qualifying-but-not-winning
   * users after an admin runs a random-roll giveaway draw.
   */
  giveawayLoss: boolean;
  /** 0–23, local-hour window during which the scheduler may send. */
  preferredHour: number;
  /** IANA timezone; used to place `preferredHour` correctly. */
  timezone: string;
}

/**
 * Admin-managed email template. Subject + HTML + optional plain-text
 * fallback; all three support `{{var}}` interpolation.
 */
export interface EmailTemplate {
  id: number;
  name: string;
  type: EmailNotificationType;
  subjectTemplate: string;
  htmlTemplate: string;
  textTemplate: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A single email delivery log entry. */
export interface EmailLogEntry {
  id: number;
  userId: string | null;
  templateId: number | null;
  type: EmailNotificationType;
  toAddress: string;
  subject: string | null;
  status:
    | "queued"
    | "sent"
    | "failed"
    | "bounced"
    | "complained"
    | "opened"
    | "clicked"
    | "suppressed";
  providerMessageId: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  createdAt: string;
}

/**
 * Admin-tunable config for each trigger. Stored one row per type in
 * `email_trigger_config`; defaults are seeded on migration.
 *
 * `thresholdJson` is type-specific: e.g. `{"days": 7}` for
 * `inactivity_reminder`, `{"streakMin": 3}` for `streak_risk`, or
 * `{"weekday": 1, "hour": 10}` for `weekly_digest`.
 */
export interface EmailTriggerConfig {
  type: EmailNotificationType;
  isEnabled: boolean;
  cooldownHours: number;
  thresholdJson: string | null;
  templateId: number | null;
  updatedAt: string;
}

/** Aggregate email stats for admin dashboard. */
export interface EmailStats {
  totalSent: number;
  totalDelivered: number;
  totalOpened: number;
  totalClicked: number;
  totalBounced: number;
  totalComplained: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  byType: Array<{
    type: EmailNotificationType;
    sent: number;
    opened: number;
    clicked: number;
    bounced: number;
    openRate: number;
    clickRate: number;
  }>;
}
