import type { GameMode } from "./types.js";

/**
 * Amazon Associates affiliate tag. Every outbound Amazon URL we render
 * — product pages, search pages, anywhere — MUST include this tag so
 * qualifying purchases are credited to our associate account. New
 * callsites must route through {@link amazonProductUrl} or
 * {@link amazonSearchUrl} (or append `&tag=${AMAZON_ASSOCIATE_TAG}`
 * manually) — no exceptions.
 */
export const AMAZON_ASSOCIATE_TAG = "pg081-20";

/**
 * Build a tagged Amazon product-detail URL for an ASIN.
 *
 * @param asin - Amazon Standard Identification Number (e.g. "B0CX23V2ZK").
 * @returns `https://www.amazon.com/dp/<asin>?tag=<AMAZON_ASSOCIATE_TAG>`.
 */
export function amazonProductUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}?tag=${AMAZON_ASSOCIATE_TAG}`;
}

/**
 * Build a tagged Amazon search URL for a free-text query.
 *
 * @param query - The user-visible search string (will be URI-encoded).
 * @returns `https://www.amazon.com/s?k=<encoded-query>&tag=<AMAZON_ASSOCIATE_TAG>`.
 */
export function amazonSearchUrl(query: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(query)}&tag=${AMAZON_ASSOCIATE_TAG}`;
}

export const MAX_PLAYERS = 6;
export const MP_ROUND_TIME_SECONDS = 30;
export const MP_PRICE_MATCH_TIME_SECONDS = 45;
export const MIN_ROUNDS = 3;
export const MAX_ROUNDS = 20;
/** When the host clicks "Start Game", a 10-second countdown shows for
 *  every player in the room before the first round actually fires. */
export const MP_HOST_START_COUNTDOWN_MS = 10_000;

/**
 * The 62 sticker-pop avatars available to users and multiplayer players.
 * PNG images live in `apps/web/src/assets/avatars/<name>.png`.
 *
 * The set combines 25 original sticker-pop characters (weather, space,
 * food, mystical) with 15 money/retail themed mascots (coins, cash,
 * gold, shopping, commerce tech), plus 22 themed additions: carnival (5),
 * mobile devices (5), board-game tokens (7), and cars (5). They are
 * interleaved so every 10-avatar picker page contains a mix of themes.
 */
export const AVATARS = [
  "silhouette",
  "rain-cloud", "moon", "gold-coin", "sun", "cactus-cowboy",
  "cash-stack", "jack-o-lantern", "piggy-bank", "fancy-ghost", "snowman",
  "money-bag", "ice-cream", "bubble-tea", "credit-card", "hot-pepper",
  "diamond", "fried-egg", "sushi", "gold-bar", "fortune-cookie",
  "pizza", "treasure-chest", "baby-dragon", "price-tag", "vampire-bat",
  "yeti", "shopping-cart", "ufo", "rocket", "shopping-bag",
  "wizard", "gift-box", "pirate", "ninja-frog", "calculator",
  "diving-helmet", "magic-8-ball", "cash-register", "grim-reaper", "vault",
  "carnival-clown", "smartphone", "top-hat", "race-car", "cotton-candy",
  "tablet", "boot", "monster-truck", "ferris-wheel", "smartwatch",
  "iron", "taxi-cab", "circus-tent", "earbuds", "thimble",
  "fire-truck", "strongman", "laptop", "wheelbarrow", "convertible",
  "battleship", "scottie-dog",
] as const;

/**
 * The subset of avatars users can select as their profile avatar.
 * Currently the full set — kept as a separate export so a future
 * "unlock" system can narrow this without changing the union type.
 */
export const PROFILE_AVATARS = AVATARS;

/**
 * Avatars eligible for random assignment when a player joins a multiplayer
 * room without picking one. Excludes "silhouette" so that logged-in users
 * who haven't set a preference get a distinctive avatar rather than the
 * anonymous placeholder. Anonymous (not-logged-in) users default to
 * "silhouette" directly in the room-join logic.
 */
export const RANDOMIZABLE_AVATARS = AVATARS.filter(
  (a) => a !== "silhouette",
) as readonly Exclude<(typeof AVATARS)[number], "silhouette">[];

/** Fallback avatar rendered when a persisted name isn't in the current list. */
export const DEFAULT_AVATAR = "wizard" as const;

/** Human-readable label for each avatar, used for aria-label and alt text. */
export const AVATAR_LABELS: Record<(typeof AVATARS)[number], string> = {
  "silhouette": "Anonymous",
  "rain-cloud": "Grumpy Cloud",
  "moon": "Sleepy Moon",
  "gold-coin": "Gold Coin",
  "sun": "Cool Sun",
  "cactus-cowboy": "Cactus Cowboy",
  "cash-stack": "Cash Stack",
  "jack-o-lantern": "Jack-o-Lantern",
  "piggy-bank": "Piggy Bank",
  "fancy-ghost": "Fancy Ghost",
  "snowman": "Snowman",
  "money-bag": "Money Bag",
  "ice-cream": "Melting Cone",
  "bubble-tea": "Bubble Tea",
  "credit-card": "Credit Card",
  "hot-pepper": "Hot Pepper",
  "diamond": "Diamond",
  "fried-egg": "Fried Egg",
  "sushi": "Salmon Nigiri",
  "gold-bar": "Gold Bar",
  "fortune-cookie": "Fortune Cookie",
  "pizza": "Cool Pizza",
  "treasure-chest": "Treasure Chest",
  "baby-dragon": "Baby Dragon",
  "price-tag": "Price Tag",
  "vampire-bat": "Vampire Bat",
  "yeti": "Cozy Yeti",
  "shopping-cart": "Shopping Cart",
  "ufo": "UFO",
  "rocket": "Rocket Ship",
  "shopping-bag": "Shopping Bag",
  "wizard": "Wizard",
  "gift-box": "Gift Box",
  "pirate": "Pirate Captain",
  "ninja-frog": "Ninja Frog",
  "calculator": "Calculator",
  "diving-helmet": "Deep Sea Diver",
  "magic-8-ball": "Magic 8-Ball",
  "cash-register": "Cash Register",
  "grim-reaper": "Tiny Reaper",
  "vault": "Bank Vault",
  "carnival-clown": "Carnival Clown",
  "smartphone": "Smartphone",
  "top-hat": "Top Hat",
  "race-car": "Race Car",
  "cotton-candy": "Cotton Candy",
  "tablet": "Tablet",
  "boot": "Boot",
  "monster-truck": "Monster Truck",
  "ferris-wheel": "Ferris Wheel",
  "smartwatch": "Smartwatch",
  "iron": "Iron",
  "taxi-cab": "Taxi Cab",
  "circus-tent": "Circus Tent",
  "earbuds": "Earbuds",
  "thimble": "Thimble",
  "fire-truck": "Fire Truck",
  "strongman": "Strongman",
  "laptop": "Laptop",
  "wheelbarrow": "Wheelbarrow",
  "convertible": "Convertible",
  "battleship": "Battleship",
  "scottie-dog": "Scottie Dog",
};

/** Type guard for valid profile avatar values. */
export function isValidProfileAvatar(value: unknown): value is (typeof PROFILE_AVATARS)[number] {
  return typeof value === "string" && (PROFILE_AVATARS as readonly string[]).includes(value);
}

/**
 * Maximum rounds supported in a single-player game. Used as the upper-bound
 * layout constant for the share grid (which renders up to 2 rows of 5).
 */
export const TOTAL_ROUNDS = 10;

/**
 * Default number of rounds played when a single-player game is started without
 * an explicit rounds choice (e.g. clicking a game card on the home screen).
 */
export const DEFAULT_TOTAL_ROUNDS = 5;

/**
 * The user-selectable round counts for the single-player Game Options menu.
 * Server-side validation MUST keep this list in sync with the accepted values.
 */
export const ROUND_COUNT_OPTIONS = [3, 5, 10] as const;
export type RoundCountOption = (typeof ROUND_COUNT_OPTIONS)[number];

/** Type guard for the user-selectable round counts. */
export function isValidRoundCount(n: unknown): n is RoundCountOption {
  return typeof n === "number" && (ROUND_COUNT_OPTIONS as readonly number[]).includes(n);
}
export const ROUND_TIME_SECONDS = 30;
export const COMPARISON_PRODUCTS_PER_ROUND = 2;
export const PRICE_MATCH_PRODUCTS_PER_ROUND = 4;
export const ODD_ONE_OUT_PRODUCTS_PER_ROUND = 4;
export const MARKET_BASKET_MAX_PRODUCTS = 6;
export const SORT_IT_OUT_PRODUCTS_PER_ROUND = 5;
export const BUDGET_BUILDER_PRODUCTS_PER_ROUND = 6;
export const CHAIN_REACTION_PRODUCTS_PER_ROUND = 5;
export const SP_CHAIN_REACTION_SUB_TIME_SECONDS = 10;
export const MP_MARKET_BASKET_TIME_SECONDS = 45;
export const MP_BUDGET_BUILDER_TIME_SECONDS = 60;
export const MP_CHAIN_REACTION_TIME_SECONDS = 84;
export const MP_BIDDING_TURN_TIME_SECONDS = 20;

export const BIDDING_SCORE_TABLE = [1000, 700, 400, 200, 100, 100] as const;
export const BIDDING_EXACT_MATCH_BONUS = 500;

export const BOT_DIFFICULTIES = ["easy", "medium", "hard"] as const;

// === Multiplayer share text & OG ============================================

/**
 * Template used by the lobby's "Share" buttons to seed the message body sent
 * to SMS / Discord / native Web Share. Contains two placeholders:
 *
 * - `{code}` — the 7-char room code (e.g. `aB3kT9_`)
 * - `{url}`  — the absolute join URL (e.g. `https://price.games/aB3kT9_`)
 *
 * Use {@link buildMpShareText} to interpolate; do not concatenate manually
 * because the template may grow extra placeholders later.
 */
export const MP_SHARE_TEXT = "Join my Price Games room {code} → {url}";

/**
 * Variant of {@link MP_SHARE_TEXT} for the Web Share API. Omits the inline
 * `{url}` because navigator.share takes a separate `url` field — many
 * receiving apps (iMessage, Discord) concatenate both, so duplicating the
 * link in `text` produces two copies of the URL in the shared message.
 */
export const MP_SHARE_TEXT_NO_URL = "Join my Price Games room {code}";

/**
 * OG/Twitter description used when a multiplayer room URL (`/<code>`) is
 * unfurled in messaging apps. Kept short (≤160 chars) so the snippet doesn't
 * truncate awkwardly. Pairs with the default site OG image.
 */
export const MP_OG_DESCRIPTION =
  "Join a live Price Games multiplayer room — guess the price of real products head-to-head, free, no signup needed.";

/**
 * Interpolate the {@link MP_SHARE_TEXT} template with the room's code and
 * absolute URL. Centralised here so the lobby UI, server-side preview cards,
 * and any future referral copy stay in sync.
 *
 * @param code - The room code (7 chars from nanoid).
 * @param url  - The absolute share URL (origin + "/" + code).
 * @returns The fully interpolated share message ready to drop into a textarea
 *          or pass to `navigator.share({ text })`.
 */
export function buildMpShareText(code: string, url: string): string {
  return MP_SHARE_TEXT.replace("{code}", code).replace("{url}", url);
}

/**
 * Variant of {@link buildMpShareText} for the Web Share API path. Drops the
 * URL from the message body since navigator.share carries it in a dedicated
 * `url` field — apps that concatenate both fields would otherwise show two
 * copies of the link to the recipient.
 *
 * @param code - The room code (7 chars from nanoid).
 * @returns The share message body (no URL — pass URL via `navigator.share({ url })`).
 */
export function buildMpShareTextNoUrl(code: string): string {
  return MP_SHARE_TEXT_NO_URL.replace("{code}", code);
}

// TODO(claude, 2026-03-11): Remove CATEGORIES constant; categories are now dynamic from DB. Only kept for the Category type alias.
export const CATEGORIES = [
  "Electronics",
  "Home & Kitchen",
  "Beauty & Personal Care",
  "Sports & Outdoors",
  "Toys & Games",
  "Clothing & Fashion",
  "Pet Supplies",
  "Tools & Home Improvement",
  "Grocery & Gourmet",
  "Baby & Kids",
  "Automotive",
  "Weird & Wonderful",
] as const;

export const VALID_GAME_MODES: Set<string> = new Set([
  "classic", "higher-lower", "comparison",
  "closest-without-going-over", "price-match", "riser",
  "odd-one-out", "market-basket", "sort-it-out",
  "budget-builder", "chain-reaction", "bidding",
]);

/** Modes that can only be played in multiplayer. Filtered from single-player mode selectors. */
export const MULTIPLAYER_ONLY_MODES: ReadonlySet<string> = new Set(["bidding"]);

// === Daily Challenge Mode ===

/** Number of rounds played in a daily challenge session. */
export const DAILY_TOTAL_ROUNDS = 5;

/**
 * The set of game modes eligible for the daily challenge. Must stay tightly
 * scoped because (a) the daily round composer only handles these modes, and
 * (b) admin schedule editing is restricted to this pool to prevent wiring up
 * modes that would silently fail at composition time.
 *
 * Bidding is included as a single-player variant: the daily challenge gives
 * the player one bid per round against the real price, scored under Price
 * Is Right rules (under = 1000, exact = +500 bonus, over = 0).
 */
export const DAILY_POOL: readonly GameMode[] = ["classic", "higher-lower", "comparison", "bidding"];

/**
 * Default 7-day rotation for the daily challenge, indexed by `Date.getUTCDay()`
 * (0 = Sunday). Admins can override this via the `daily_schedule` site setting,
 * but the override is also constrained to DAILY_POOL.
 *
 * Schedule rationale: classic anchors Mon/Thu (the canonical "Wordle-like"
 * mode with the widest score distribution), higher-lower covers Tue/Fri/Sun
 * (lighter cognitive load for weekday mornings/weekends), comparison fills
 * Wed/Sat (the binary outcome adds variety mid-week and on Saturday).
 */
export const DEFAULT_DAILY_SCHEDULE: readonly GameMode[] = [
  "higher-lower", // Sun (0)
  "classic",      // Mon (1)
  "higher-lower", // Tue (2)
  "comparison",   // Wed (3)
  "classic",      // Thu (4)
  "higher-lower", // Fri (5)
  "comparison",   // Sat (6)
];

/**
 * Modes the admin panel allows assigning to a daily slot. Covers every
 * registered game mode: the daily composer now understands how to compose
 * deterministic rounds for each mode (with seeded metadata where the mode
 * requires it), so admins are no longer restricted to DAILY_POOL.
 */
export const DAILY_ADMIN_ALLOWED_MODES: readonly GameMode[] = [
  "classic",
  "higher-lower",
  "comparison",
  "closest-without-going-over",
  "price-match",
  "riser",
  "odd-one-out",
  "market-basket",
  "sort-it-out",
  "budget-builder",
  "chain-reaction",
  "bidding",
];

/**
 * How many products a given game mode needs per round. Shared between the
 * backend (daily round composer, manual-override product-count validation)
 * and the admin UI (which uses it to size the per-round product slot grid).
 *
 * @param mode - The game mode
 * @returns Product count for one round of that mode
 */
export function getDailyProductsPerRound(mode: GameMode): number {
  switch (mode) {
    case "comparison": return COMPARISON_PRODUCTS_PER_ROUND;
    case "price-match": return PRICE_MATCH_PRODUCTS_PER_ROUND;
    case "odd-one-out": return ODD_ONE_OUT_PRODUCTS_PER_ROUND;
    case "market-basket": return MARKET_BASKET_MAX_PRODUCTS;
    case "sort-it-out": return SORT_IT_OUT_PRODUCTS_PER_ROUND;
    case "budget-builder": return BUDGET_BUILDER_PRODUCTS_PER_ROUND;
    case "chain-reaction": return CHAIN_REACTION_PRODUCTS_PER_ROUND;
    default: return 1;
  }
}

/**
 * The launch epoch used to compute the user-visible daily number ("Daily #N").
 * Choose carefully — this is permanent. Once any production deploy uses a
 * given value, never change it without bumping the salt and accepting that
 * historical share grids will reference a different "#N" than the new ones.
 */
export const DAILY_LAUNCH_EPOCH = "2026-04-14";

export const GAME_MODES: { mode: GameMode; name: string; description: string }[] = [
  { mode: "classic", name: "Precision", description: "Guess the exact price of each product" },
  { mode: "higher-lower", name: "Higher or Lower", description: "Is the real price higher or lower?" },
  { mode: "comparison", name: "Comparison", description: "Which product costs more (or less)?" },
  { mode: "closest-without-going-over", name: "Underbid", description: "Guess close — but stay under the real price!" },
  { mode: "price-match", name: "Price Match", description: "Match 4 products to their correct prices" },
  { mode: "riser", name: "Riser", description: "Stop the rising price before it goes over!" },
  { mode: "odd-one-out", name: "Odd One Out", description: "Find the product that doesn't match the price group" },
  { mode: "market-basket", name: "Market Basket", description: "Estimate the total cost of a basket of products" },
  { mode: "sort-it-out", name: "Sort It Out", description: "Rank the products from cheapest to most expensive" },
  { mode: "budget-builder", name: "Budget Builder", description: "Pick items that fit within the given budget" },
  { mode: "chain-reaction", name: "Chain Reaction", description: "Build a chain of products by ascending price" },
  { mode: "bidding", name: "Bidding War", description: "Bid in turns — closest without going over wins!" },
];

/**
 * Returns the human-readable display name for a game mode (e.g. "Precision" for "classic").
 * Single source of truth; replaces duplicated MODE_LABELS maps that previously lived in UI files.
 *
 * @param mode - The game mode identifier
 * @returns The display name from GAME_MODES, or the raw mode string if not found (defensive; all
 *          valid GameMode values are guaranteed to exist in GAME_MODES)
 */
export function getGameModeName(mode: GameMode): string {
  return GAME_MODES.find((m) => m.mode === mode)?.name ?? mode;
}

/** Socket.IO event names used by both client and server */
export const SOCKET_EVENTS = {
  // Room management
  ROOM_CREATE: "room:create",
  ROOM_JOIN: "room:join",
  ROOM_REJOIN: "room:rejoin",
  ROOM_KICK: "room:kick",
  ROOM_SETTINGS: "room:settings",
  ROOM_START_ROUND: "room:start_round",
  ROOM_HOST_START_COUNTDOWN: "room:host_start_countdown",
  ROOM_PLAY_AGAIN: "room:play_again",

  // Server → Client room events
  ROOM_PLAYER_JOINED: "room:player_joined",
  ROOM_PLAYER_LEFT: "room:player_left",
  ROOM_PLAYER_RECONNECTED: "room:player_reconnected",
  ROOM_HOST_CHANGED: "room:host_changed",
  ROOM_PLAYER_KICKED: "room:player_kicked",
  ROOM_SETTINGS_UPDATED: "room:settings_updated",
  ROOM_UPDATED: "room:updated",

  // Gameplay
  GAME_SUBMIT_GUESS: "game:submit_guess",
  GAME_CONTINUE: "game:continue",
  GAME_ROUND_START: "game:round_start",
  GAME_ROUND_END: "game:round_end",
  GAME_PLAYER_LOCKED: "game:player_locked",
  GAME_PLAYER_CONTINUED: "game:player_continued",
  GAME_OVER: "game:over",

  // Bidding mode
  GAME_SUBMIT_BID: "game:submit_bid",
  GAME_BIDDING_TURN: "game:bidding_turn",
  GAME_BID_PLACED: "game:bid_placed",

  // Bot configuration
  ROOM_BOT_CONFIG: "room:bot_config",
  ROOM_BOTS_UPDATED: "room:bots_updated",

  // Ready-up
  ROOM_READY: "room:ready",
  ROOM_PLAYER_READY: "room:player_ready",

  // Push notifications (server → client)
  NOTIFICATION_RECEIVED: "notification:received",

  // Liveness heartbeat used by the client on tab-resume to detect
  // "zombie" sockets (connection appears OPEN but the underlying
  // transport is dead — common on iOS Safari after backgrounding).
  MP_HEARTBEAT: "mp:heartbeat",

  // Server → Client: latest stats from the 24/7 streamer-bot. Emitted
  // whenever the bot POSTs `/api/streamer/stats` and broadcast to all
  // sockets so any `?broadcast=1` viewer (including the bot's own
  // Chromium and any external operator preview) sees the same numbers.
  // Replaces the original local-only `window.postMessage` design,
  // which only worked for the bot's own tab.
  STREAMER_BOT_STATS: "streamer:stats",

  // Server → Client: latest "now playing" track from the streamer-bot's
  // mpd music source. Same shape and motivation as STREAMER_BOT_STATS
  // — the original `music.now` postMessage was same-window only and
  // never reached external `?broadcast=1` viewers. Payload is
  // `{ title, artist?, album? }` or `null` when the queue stops.
  STREAMER_BOT_MUSIC: "streamer:music",

  // Server → Client: streamer-bot NN visualisation tick. Carries the
  // pre-encoded VisualTick payload (network activations, prediction +
  // sigma, recent loss sparkline samples, recent-accuracy bucket history,
  // belief card fields, embedding 2-d projection, optional teaching-moment
  // "aha" trigger). Emitted whenever the bot POSTs `/api/streamer/nn-tick`
  // — typically once per round, after the result has been observed.
  STREAMER_BOT_NN_TICK: "streamer:nn-tick",

  // Server → Client: full mood-engine snapshot (mood label + hidden
  // vibe + hidden morale + signed round streak). Emitted whenever the
  // bot POSTs `/api/streamer/mood` — typically once per `nextMood`
  // call, debounced. Richer than the `mood` field on STREAMER_BOT_STATS
  // (which only carries the label) — overlay panels can read the
  // hidden axes for trend arrows / morale bars.
  STREAMER_BOT_MOOD: "streamer:mood",

  // Server → Client (sandbox-only): a single tts.utterance.* envelope
  // generated by the sandbox's POST /api/sandbox/tts/cycle-moods
  // endpoint. The endpoint spawns a real Piper subprocess for each
  // mood and forwards every UtteranceController emission (start /
  // audio_started / audio_batch / audio_ended) through this channel
  // so the broadcast page exercises the same envelope-reducer path
  // production uses, including real-time PCM batching cadence. Payload
  // shape is `{ kind, payload }` — the relay hook re-issues each as a
  // `window.postMessage({source:'pg-bot', kind, payload}, '*')` so the
  // existing overlayBus reducer is the single consumer. Only emitted
  // in sandbox mode; production never wires this event.
  STREAMER_BOT_TTS_ENVELOPE: "streamer:tts-envelope",
} as const;

/**
 * Typed rejoin failure reasons sent from the server in the
 * `ROOM_REJOIN` ack when the client cannot resume a room. The client
 * maps each code to a user-facing message.
 *
 * Note: there is deliberately no `room_full` code because a
 * disconnected player's `mp_players` row persists across the
 * disconnect, so their slot cannot be taken. A rejoin either finds
 * the player (ok), the player marked kicked (`kicked`), or the row
 * is gone entirely (`invalid_token` / `room_expired`).
 */
export type RejoinErrorCode =
  | "room_expired"
  | "kicked"
  | "invalid_token"
  | "unknown";

/**
 * Grace period, in milliseconds, that the server waits after a socket
 * disconnects before marking the player as left and broadcasting
 * `ROOM_PLAYER_LEFT`. Allows transient mobile-backgrounding blips to
 * be invisible to the rest of the room.
 */
export const MP_DISCONNECT_GRACE_MS = 15_000;

/** Client-side TTL for the saved multiplayer rejoin session. */
export const MP_SESSION_TTL_MS = 30 * 60 * 1000;

/** Notification type identifiers used across client and server. */
export const NOTIFICATION_TYPES = {
  DAILY_PUZZLE: "daily_puzzle",
  STREAK_REMINDER: "streak_reminder",
  LEADERBOARD_UPDATES: "leaderboard_updates",
  LEADERBOARD_PLACEMENT: "leaderboard_placement",
  MULTIPLAYER_INVITES: "multiplayer_invites",
  PROMOTIONAL: "promotional",
} as const;

/** Default preference values for new users (all engagement types on, promotional off). */
export const DEFAULT_NOTIFICATION_PREFERENCES = {
  pushEnabled: true,
  dailyPuzzle: true,
  streakReminder: true,
  leaderboardUpdates: false,
  leaderboardPlacement: true,
  multiplayerInvites: true,
  promotional: false,
  quietHoursStart: null as string | null,
  quietHoursEnd: null as string | null,
  timezone: "UTC",
} as const;

/**
 * Email notification type identifiers. Kept separate from
 * NOTIFICATION_TYPES because the email triggers and cadence are distinct
 * from push and merging the two would force one cadence on the other.
 */
export const EMAIL_NOTIFICATION_TYPES = {
  STREAK_RISK: "streak_risk",
  STREAK_SAVE: "streak_save",
  INACTIVITY_REMINDER: "inactivity_reminder",
  WEEKLY_DIGEST: "weekly_digest",
  LEADERBOARD_PLACEMENT: "leaderboard_placement",
  PROMOTIONAL: "promotional",
  GIVEAWAY_LOSS: "giveaway_loss",
  CUSTOM: "custom",
} as const;

/**
 * Default email preferences — all opt-in, all off. Email is rarer than
 * push by policy: users must explicitly enable each type.
 *
 * `giveawayLoss` is the lone exception: it defaults to `true` because it
 * is a transactional follow-up to a giveaway the user opted into by
 * playing. Users can still disable it from the settings page.
 */
export const DEFAULT_EMAIL_PREFERENCES = {
  emailEnabled: false,
  streakRisk: false,
  streakSave: false,
  inactivityReminder: false,
  weeklyDigest: false,
  leaderboardPlacement: false,
  promotional: false,
  giveawayLoss: true,
  preferredHour: 10,
  timezone: "UTC",
} as const;
