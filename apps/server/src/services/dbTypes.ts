/**
 * Canonical database row interfaces for multiplayer tables.
 *
 * These are the superset types covering all columns returned by `SELECT *`.
 * Previously each file defined its own subset interface, leading to drift
 * when columns were added. All multiplayer service files should import
 * these types instead of defining local copies.
 */

/** Row from the mp_rooms table. */
export interface DbRoom {
  code: string;
  host_player_id: string;
  creator_player_id: string;
  game_mode: string;
  category: string | null;
  password: string | null;
  status: string;
  current_round: number;
  total_rounds: number;
  selected_products: string | null;
  round_data: string | null;
  created_at: string;
  finished_at: string | null;
  last_activity_at: string | null;
  is_public: number;
  bot_count: number;
  bot_difficulty: string;
  is_daily_game: number;
  daily_date: string | null;
  is_auto_lobby: number;
  countdown_started_at: string | null;
  countdown_target_at: string | null;
  current_game_id: string | null;
}

/** Row from the mp_players table. */
export interface DbPlayer {
  id: string;
  room_code: string;
  display_name: string;
  avatar: string;
  token: string;
  is_host: number;
  is_kicked: number;
  total_score: number;
  connected: number;
  joined_at: string;
  user_id: string | null;
  visitor_id: string | null;
  is_bot: number;
  is_disguised: number;
  ghost_user_id: string | null;
  join_source: string | null;
  /**
   * 1 when the socket joining this seat carried the streamer-bot
   * shared-secret header. Distinct from `is_bot` (which marks server-spawned
   * auto-lobby bots): the streamer-bot is an external Playwright client and
   * still drives its own moves — only the analytics/leaderboard write paths
   * skip it.
   */
  is_streamer_bot: number;
}

/** Row from the ghost_users table. */
export interface DbGhostUser {
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
  daily_play_probability: number;
  last_daily_decision_date: string | null;
  created_at: string;
  updated_at: string;
}

/** Row from the ghost_game_history table. */
export interface DbGhostGameHistory {
  id: number;
  ghost_user_id: string;
  game_type: string;
  game_mode: string;
  room_code: string | null;
  score: number;
  placement: number | null;
  players_count: number | null;
  played_at: string;
}
