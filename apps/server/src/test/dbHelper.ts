/**
 * Test database helper.
 *
 * Creates an in-memory SQLite database with the same schema as the production
 * database. Used by tests to avoid touching real data.
 */

import Database, { Database as DatabaseType } from "better-sqlite3";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { tzDateString, ADMIN_TIMEZONE } from "@price-game/shared";
import { createContactsDb, insertManufacturer, insertContact } from "../pipeline/manufacturer-contacts/contacts-db";
import type { ContactInput } from "../pipeline/manufacturer-contacts/types";

/**
 * Create a fresh in-memory SQLite database with the full schema.
 *
 * @returns A new database instance for testing.
 */
export function createTestDb(): DatabaseType {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      asin TEXT,
      title TEXT NOT NULL,
      image_url TEXT,
      description TEXT,
      price_cents INTEGER NOT NULL,
      category TEXT,
      is_active BOOLEAN DEFAULT 1,
      is_archived INTEGER DEFAULT 0,
      last_used_at TEXT,
      scraped_at TEXT,
      added_at TEXT,
      verified INTEGER DEFAULT 0,
      manufacturer TEXT
    );

    CREATE TABLE IF NOT EXISTS game_sessions (
      id TEXT PRIMARY KEY,
      current_round INTEGER DEFAULT 1,
      total_score INTEGER DEFAULT 0,
      selected_products TEXT,
      started_at TEXT,
      completed_at TEXT,
      game_mode TEXT DEFAULT 'classic',
      round_data TEXT,
      user_id TEXT,
      is_daily INTEGER NOT NULL DEFAULT 0,
      daily_date TEXT,
      total_rounds INTEGER,
      visitor_id TEXT
    );

    CREATE TABLE IF NOT EXISTS game_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      guessed_price_cents INTEGER,
      score INTEGER,
      guessed_at TEXT,
      guess_data TEXT,
      FOREIGN KEY (session_id) REFERENCES game_sessions(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS leaderboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_name TEXT NOT NULL,
      session_id TEXT,
      score INTEGER NOT NULL,
      played_at TEXT,
      game_mode TEXT DEFAULT 'classic',
      user_id TEXT,
      excluded_at TEXT,
      excluded_by_admin_id TEXT,
      excluded_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS mp_rooms (
      code TEXT PRIMARY KEY,
      host_player_id TEXT NOT NULL,
      creator_player_id TEXT,
      game_mode TEXT NOT NULL DEFAULT 'classic',
      category TEXT,
      password TEXT,
      status TEXT NOT NULL DEFAULT 'lobby',
      current_round INTEGER DEFAULT 0,
      total_rounds INTEGER DEFAULT 10,
      selected_products TEXT,
      round_data TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      last_activity_at TEXT,
      is_public INTEGER DEFAULT 0,
      bot_count INTEGER DEFAULT 0,
      bot_difficulty TEXT DEFAULT 'medium',
      is_daily_game INTEGER NOT NULL DEFAULT 0,
      daily_date TEXT,
      is_auto_lobby INTEGER NOT NULL DEFAULT 0,
      countdown_started_at TEXT,
      countdown_target_at TEXT,
      current_game_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mp_rooms_public_lobby ON mp_rooms(is_public, status);
    CREATE INDEX IF NOT EXISTS idx_mp_rooms_daily_lobby
      ON mp_rooms(daily_date, status)
      WHERE is_daily_game = 1;
    CREATE INDEX IF NOT EXISTS idx_mp_rooms_auto_lobby
      ON mp_rooms(is_auto_lobby, status)
      WHERE is_auto_lobby = 1;

    CREATE TABLE IF NOT EXISTS mp_players (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      is_host INTEGER DEFAULT 0,
      is_kicked INTEGER DEFAULT 0,
      total_score INTEGER DEFAULT 0,
      connected INTEGER DEFAULT 1,
      joined_at TEXT NOT NULL,
      user_id TEXT,
      visitor_id TEXT,
      is_bot INTEGER DEFAULT 0,
      is_disguised INTEGER NOT NULL DEFAULT 0,
      ghost_user_id TEXT,
      join_source TEXT,
      is_streamer_bot INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (room_code) REFERENCES mp_rooms(code)
    );
    CREATE INDEX IF NOT EXISTS idx_mp_players_ghost
      ON mp_players(ghost_user_id) WHERE ghost_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mp_players_join_source
      ON mp_players(join_source) WHERE join_source IS NOT NULL;

    CREATE TABLE IF NOT EXISTS mp_guesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code TEXT NOT NULL,
      player_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      guess_data TEXT,
      score INTEGER DEFAULT 0,
      submitted_at TEXT,
      FOREIGN KEY (room_code) REFERENCES mp_rooms(code),
      FOREIGN KEY (player_id) REFERENCES mp_players(id),
      UNIQUE(room_code, player_id, round_number)
    );

    CREATE TABLE IF NOT EXISTS mp_leaderboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_name TEXT NOT NULL,
      room_code TEXT,
      score INTEGER NOT NULL,
      placement INTEGER NOT NULL,
      players_count INTEGER NOT NULL,
      game_mode TEXT NOT NULL,
      played_at TEXT NOT NULL,
      user_id TEXT,
      ghost_user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS ghost_users (
      id                     TEXT PRIMARY KEY,
      username               TEXT NOT NULL UNIQUE,
      username_normalized    TEXT NOT NULL UNIQUE,
      avatar                 TEXT NOT NULL,
      lifetime_score         INTEGER NOT NULL DEFAULT 0,
      account_created_at     TEXT NOT NULL,
      on_shift               INTEGER NOT NULL DEFAULT 0,
      shift_started_at       TEXT,
      shift_ends_at          TEXT,
      on_break_until         TEXT,
      is_active              INTEGER NOT NULL DEFAULT 1,
      last_played_at         TEXT,
      daily_streak_current   INTEGER NOT NULL DEFAULT 0,
      daily_streak_best      INTEGER NOT NULL DEFAULT 0,
      daily_streak_last_date TEXT,
      daily_play_probability REAL NOT NULL DEFAULT 0.7,
      last_daily_decision_date TEXT,
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ghost_users_on_shift
      ON ghost_users(on_shift) WHERE on_shift = 1;
    CREATE INDEX IF NOT EXISTS idx_ghost_users_active
      ON ghost_users(is_active) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_ghost_users_lifetime
      ON ghost_users(lifetime_score DESC);

    CREATE TABLE IF NOT EXISTS ghost_game_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ghost_user_id   TEXT NOT NULL,
      game_type       TEXT NOT NULL,
      game_mode       TEXT NOT NULL,
      room_code       TEXT,
      score           INTEGER NOT NULL,
      placement       INTEGER,
      players_count   INTEGER,
      played_at       TEXT NOT NULL,
      FOREIGN KEY (ghost_user_id) REFERENCES ghost_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ghost_game_history
      ON ghost_game_history(ghost_user_id, played_at DESC);

    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      is_active INTEGER DEFAULT 1,
      failed_login_count INTEGER DEFAULT 0,
      locked_until TEXT,
      can_use_extension INTEGER DEFAULT 0,
      totp_secret_encrypted TEXT,
      totp_enabled INTEGER DEFAULT 0,
      totp_verified_at TEXT,
      totp_last_used_counter INTEGER
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      admin_user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
    );

    CREATE TABLE IF NOT EXISTS admin_2fa_recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      is_used INTEGER DEFAULT 0,
      used_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_admin_2fa_recovery_user
      ON admin_2fa_recovery_codes(admin_user_id, is_used);

    CREATE TABLE IF NOT EXISTS admin_2fa_pending (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      admin_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_2fa_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_admin_2fa_audit_user
      ON admin_2fa_audit_log(admin_user_id, created_at);

    CREATE TABLE IF NOT EXISTS analytics_daily (
      date TEXT NOT NULL,
      game_type TEXT NOT NULL,
      game_mode TEXT NOT NULL,
      games_started INTEGER DEFAULT 0,
      games_completed INTEGER DEFAULT 0,
      total_players INTEGER DEFAULT 0,
      total_score_sum INTEGER DEFAULT 0,
      total_rounds_played INTEGER DEFAULT 0,
      PRIMARY KEY (date, game_type, game_mode)
    );

    CREATE TABLE IF NOT EXISTS analytics_daily_categories (
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      rounds_played INTEGER DEFAULT 0,
      PRIMARY KEY (date, category)
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      username_normalized TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email_verified INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      is_active INTEGER DEFAULT 1,
      failed_login_count INTEGER DEFAULT 0,
      locked_until TEXT,
      lifetime_score INTEGER DEFAULT 0,
      best_rank INTEGER,
      oauth_provider TEXT,
      oauth_provider_id TEXT,
      username_pending INTEGER DEFAULT 0,
      referral_code TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      utm_term TEXT,
      landing_page TEXT,
      signup_referrer TEXT,
      daily_streak_current INTEGER NOT NULL DEFAULT 0,
      daily_streak_best INTEGER NOT NULL DEFAULT 0,
      daily_streak_last_date TEXT,
      avatar TEXT,
      total_sessions INTEGER NOT NULL DEFAULT 0,
      last_session_at INTEGER,
      signup_session_id TEXT,
      primary_device_type TEXT,
      primary_country TEXT,
      leaderboard_banned_at TEXT,
      leaderboard_banned_until TEXT,
      leaderboard_banned_reason TEXT,
      leaderboard_banned_by TEXT,
      is_test_account INTEGER NOT NULL DEFAULT 0,
      total_games INTEGER NOT NULL DEFAULT 0,
      lifetime_wins INTEGER NOT NULL DEFAULT 0,
      lifetime_losses INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      best_win_streak INTEGER NOT NULL DEFAULT 0,
      is_bot INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS admin_leaderboard_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id TEXT NOT NULL,
      admin_username TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_label TEXT,
      reason TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
    CREATE INDEX IF NOT EXISTS idx_users_lifetime_score ON users(lifetime_score DESC);

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

    CREATE TABLE IF NOT EXISTS user_game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      game_type TEXT NOT NULL,
      game_mode TEXT NOT NULL,
      session_id TEXT,
      room_code TEXT,
      score INTEGER NOT NULL,
      placement INTEGER,
      players_count INTEGER,
      played_at TEXT NOT NULL,
      share_id TEXT,
      was_buffed INTEGER NOT NULL DEFAULT 0,
      raw_score INTEGER,
      excluded_at TEXT,
      excluded_by_admin_id TEXT,
      excluded_reason TEXT,
      is_win INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_game_history_excluded
      ON user_game_history(excluded_at);

    -- Lobby-invite reward system (migration v48)
    CREATE TABLE IF NOT EXISTS mp_invite_tokens (
      token              TEXT PRIMARY KEY,
      room_code          TEXT NOT NULL,
      inviter_user_id    TEXT,
      inviter_visitor_id TEXT NOT NULL,
      inviter_ip         TEXT NOT NULL,
      inviter_fp         TEXT,
      created_at         INTEGER NOT NULL,
      revoked_at         INTEGER,
      FOREIGN KEY (room_code) REFERENCES mp_rooms(code) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_invite_tokens_room ON mp_invite_tokens(room_code);
    CREATE INDEX IF NOT EXISTS idx_invite_tokens_inviter_user ON mp_invite_tokens(inviter_user_id);
    CREATE INDEX IF NOT EXISTS idx_invite_tokens_inviter_visitor ON mp_invite_tokens(inviter_visitor_id);

    CREATE TABLE IF NOT EXISTS mp_invite_attributions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      token               TEXT NOT NULL,
      room_code           TEXT NOT NULL,
      joiner_player_id    TEXT NOT NULL,
      joiner_user_id      TEXT,
      joiner_visitor_id   TEXT NOT NULL,
      joiner_ip           TEXT NOT NULL,
      joiner_fp           TEXT,
      joiner_identity_key TEXT NOT NULL,
      status              TEXT NOT NULL,
      reject_reason       TEXT,
      rounds_completed    INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      earned_at           INTEGER,
      FOREIGN KEY (token) REFERENCES mp_invite_tokens(token) ON DELETE CASCADE,
      FOREIGN KEY (room_code) REFERENCES mp_rooms(code) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attr_token_status
      ON mp_invite_attributions(token, status, earned_at);
    CREATE INDEX IF NOT EXISTS idx_attr_pair_recent
      ON mp_invite_attributions(joiner_identity_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_attr_joiner_player
      ON mp_invite_attributions(joiner_player_id);

    CREATE TABLE IF NOT EXISTS mp_pending_buffs (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      beneficiary_user_id    TEXT,
      beneficiary_visitor_id TEXT NOT NULL,
      source                 TEXT NOT NULL,
      attribution_id         INTEGER,
      multiplier             REAL NOT NULL,
      matches_remaining      INTEGER NOT NULL,
      expires_at             INTEGER NOT NULL,
      created_at             INTEGER NOT NULL,
      FOREIGN KEY (attribution_id) REFERENCES mp_invite_attributions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_buffs_user_active
      ON mp_pending_buffs(beneficiary_user_id, matches_remaining);
    CREATE INDEX IF NOT EXISTS idx_buffs_visitor_active
      ON mp_pending_buffs(beneficiary_visitor_id, matches_remaining);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_game_history_session
      ON user_game_history(user_id, session_id)
      WHERE session_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS user_rank_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      total_players INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_rank_history_user
      ON user_rank_history(user_id, recorded_at);

    CREATE TABLE IF NOT EXISTS user_rewards (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      reward_type TEXT NOT NULL,
      reward_data TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      earned_at TEXT NOT NULL,
      redeemed_at TEXT,
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_product_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_upv_user_product_session
      ON user_product_views(user_id, product_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_upv_user_seen ON user_product_views(user_id, seen_at DESC);

    -- Product Universe tables
    CREATE TABLE IF NOT EXISTS pu_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      content_hash TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pu_sources_url ON pu_sources(url);

    CREATE TABLE IF NOT EXISTS pu_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT,
      description TEXT,
      sustainability_score REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pu_product_materials (
      product_id INTEGER NOT NULL,
      material_id INTEGER NOT NULL,
      percentage REAL,
      confidence TEXT NOT NULL DEFAULT 'medium',
      source_id INTEGER,
      PRIMARY KEY (product_id, material_id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (material_id) REFERENCES pu_materials(id),
      FOREIGN KEY (source_id) REFERENCES pu_sources(id)
    );

    CREATE TABLE IF NOT EXISTS pu_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      website TEXT,
      logo_url TEXT,
      founded_year INTEGER,
      headquarters TEXT,
      employee_count INTEGER,
      revenue TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pu_companies_name ON pu_companies(name);

    CREATE TABLE IF NOT EXISTS pu_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      country TEXT NOT NULL,
      region TEXT,
      latitude REAL,
      longitude REAL,
      location_type TEXT
    );

    CREATE TABLE IF NOT EXISTS pu_supply_chain_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      node_type TEXT NOT NULL,
      company_id INTEGER,
      location_id INTEGER,
      description TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'medium',
      source_id INTEGER,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (company_id) REFERENCES pu_companies(id),
      FOREIGN KEY (location_id) REFERENCES pu_locations(id),
      FOREIGN KEY (source_id) REFERENCES pu_sources(id)
    );

    CREATE TABLE IF NOT EXISTS pu_company_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      related_company_id INTEGER NOT NULL,
      relationship_type TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'medium',
      source_id INTEGER,
      FOREIGN KEY (company_id) REFERENCES pu_companies(id),
      FOREIGN KEY (related_company_id) REFERENCES pu_companies(id),
      UNIQUE(company_id, related_company_id, relationship_type)
    );

    CREATE TABLE IF NOT EXISTS pu_product_companies (
      product_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'medium',
      source_id INTEGER,
      PRIMARY KEY (product_id, company_id, role),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (company_id) REFERENCES pu_companies(id),
      FOREIGN KEY (source_id) REFERENCES pu_sources(id)
    );

    CREATE TABLE IF NOT EXISTS pu_product_similarity (
      product_id_a INTEGER NOT NULL,
      product_id_b INTEGER NOT NULL,
      score REAL NOT NULL,
      reason TEXT,
      PRIMARY KEY (product_id_a, product_id_b),
      FOREIGN KEY (product_id_a) REFERENCES products(id),
      FOREIGN KEY (product_id_b) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS pu_galaxy_positions (
      product_id INTEGER PRIMARY KEY,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      cluster INTEGER,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS pu_enrichment_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      company_id INTEGER,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (company_id) REFERENCES pu_companies(id)
    );

    CREATE TABLE IF NOT EXISTS pu_search_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL UNIQUE,
      result_json TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pu_material_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      role TEXT,
      confidence TEXT NOT NULL DEFAULT 'medium',
      source_id INTEGER,
      FOREIGN KEY (material_id) REFERENCES pu_materials(id),
      FOREIGN KEY (location_id) REFERENCES pu_locations(id),
      FOREIGN KEY (source_id) REFERENCES pu_sources(id),
      UNIQUE(material_id, location_id)
    );

    -- Rewards system
    CREATE TABLE IF NOT EXISTS reward_pool (
      id TEXT PRIMARY KEY,
      reward_type TEXT NOT NULL DEFAULT 'amazon_gift_card',
      amount_cents INTEGER NOT NULL,
      code TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_pool_code ON reward_pool(code);

    CREATE TABLE IF NOT EXISTS reward_awards (
      id TEXT PRIMARY KEY,
      reward_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      award_method TEXT NOT NULL,
      award_criteria TEXT,
      awarded_at TEXT NOT NULL,
      awarded_by TEXT NOT NULL,
      claimed_at TEXT,
      claim_token TEXT NOT NULL,
      claim_expires_at TEXT NOT NULL,
      voided_at TEXT,
      reminder_15d_sent_at TEXT,
      reminder_7d_sent_at TEXT,
      reminder_1d_sent_at TEXT,
      expired_email_sent_at TEXT,
      pending_review_at TEXT,
      FOREIGN KEY (reward_id) REFERENCES reward_pool(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_awards_active_reward
      ON reward_awards(reward_id) WHERE voided_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_awards_claim_token
      ON reward_awards(claim_token);

    -- Referrals
    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL UNIQUE,
      referral_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      referrer_ip TEXT,
      referred_ip TEXT,
      created_at TEXT NOT NULL,
      credited_at TEXT,
      FOREIGN KEY (referrer_id) REFERENCES users(id),
      FOREIGN KEY (referred_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

    -- Site settings
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shared_games (
      id TEXT PRIMARY KEY,
      game_mode TEXT NOT NULL,
      total_score INTEGER NOT NULL,
      per_round_max INTEGER NOT NULL,
      player_name TEXT,
      round_data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shared_games_created ON shared_games(created_at);

    -- Daily challenge mode (migration v31)
    CREATE TABLE IF NOT EXISTS daily_puzzles (
      daily_date          TEXT PRIMARY KEY,
      game_mode           TEXT NOT NULL,
      product_ids         TEXT NOT NULL,
      round_data          TEXT,
      salt_version        INTEGER NOT NULL DEFAULT 1,
      is_manual_override  INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      updated_at          TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_plays (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id               TEXT,
      session_id            TEXT NOT NULL UNIQUE,
      daily_date            TEXT NOT NULL,
      game_mode             TEXT NOT NULL,
      score                 INTEGER NOT NULL DEFAULT 0,
      per_round_scores      TEXT,
      streak_at_completion  INTEGER,
      started_at            TEXT NOT NULL,
      completed_at          TEXT,
      visitor_id            TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_plays_user_date
      ON daily_plays(user_id, daily_date)
      WHERE user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_daily_plays_date ON daily_plays(daily_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_plays_visitor_date
      ON daily_plays(visitor_id, daily_date)
      WHERE visitor_id IS NOT NULL;

    -- UTM tag presets (migration v29 + v30 short-link columns + v66 origin_key)
    CREATE TABLE IF NOT EXISTS utm_tags (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE,
      utm_source      TEXT NOT NULL,
      utm_medium      TEXT,
      utm_campaign    TEXT,
      utm_content     TEXT,
      utm_term        TEXT,
      destination_url TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active', 'archived')),
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      created_by      TEXT,
      short_code      TEXT,
      click_count     INTEGER NOT NULL DEFAULT 0,
      last_clicked_at TEXT,
      origin_key      TEXT,
      FOREIGN KEY (created_by) REFERENCES admin_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_utm_tags_status ON utm_tags(status);
    CREATE INDEX IF NOT EXISTS idx_utm_tags_source_campaign
      ON utm_tags(utm_source, utm_campaign);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_utm_tags_short_code
      ON utm_tags(short_code)
      WHERE short_code IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_utm_tags_origin_dest
      ON utm_tags(origin_key, destination_url)
      WHERE origin_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_utm_cohort
      ON users(utm_source, utm_medium, utm_campaign);

    -- Anonymous visitor attribution (migration v31)
    CREATE TABLE IF NOT EXISTS visitor_attribution (
      visitor_id       TEXT PRIMARY KEY,
      utm_source       TEXT NOT NULL,
      utm_medium       TEXT,
      utm_campaign     TEXT,
      utm_content      TEXT,
      utm_term         TEXT,
      landing_page     TEXT,
      referrer         TEXT,
      first_seen_at    TEXT NOT NULL,
      first_game_at    TEXT,
      first_game_type  TEXT,
      first_game_mode  TEXT,
      games_played     INTEGER NOT NULL DEFAULT 0,
      claimed_user_id  TEXT,
      claimed_at       TEXT,
      lifetime_wins    INTEGER NOT NULL DEFAULT 0,
      lifetime_losses  INTEGER NOT NULL DEFAULT 0,
      current_streak   INTEGER NOT NULL DEFAULT 0,
      best_win_streak  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_visitor_attribution_utm
      ON visitor_attribution(utm_source, utm_medium, utm_campaign);
    CREATE INDEX IF NOT EXISTS idx_visitor_attribution_claimed
      ON visitor_attribution(claimed_user_id);

    -- Push notification tables (migration v35)
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      expiration_time INTEGER,
      user_agent TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      visitor_id TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_push_subs_active ON push_subscriptions(is_active, user_id);
    CREATE INDEX IF NOT EXISTS idx_push_subs_visitor
      ON push_subscriptions(visitor_id) WHERE visitor_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT PRIMARY KEY,
      push_enabled INTEGER DEFAULT 1,
      daily_puzzle INTEGER DEFAULT 1,
      streak_reminder INTEGER DEFAULT 1,
      leaderboard_updates INTEGER DEFAULT 0,
      leaderboard_placement INTEGER DEFAULT 1,
      multiplayer_invites INTEGER DEFAULT 1,
      promotional INTEGER DEFAULT 0,
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      timezone TEXT DEFAULT 'UTC',
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS leaderboard_placement_notifications (
      user_id           TEXT NOT NULL,
      period            TEXT NOT NULL,
      period_key        TEXT NOT NULL,
      best_rank         INTEGER NOT NULL,
      channel           TEXT NOT NULL DEFAULT 'any',
      last_notified_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, period, period_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_leaderboard_placement_period
      ON leaderboard_placement_notifications(period, period_key);

    CREATE TABLE IF NOT EXISTS notification_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      title_template TEXT NOT NULL,
      body_template TEXT NOT NULL,
      icon TEXT DEFAULT '/logo192.png',
      url_path TEXT DEFAULT '/',
      actions_json TEXT,
      ttl INTEGER DEFAULT 3600,
      urgency TEXT DEFAULT 'normal',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      subscription_id INTEGER,
      template_id INTEGER,
      type TEXT NOT NULL,
      title TEXT,
      body TEXT,
      url_path TEXT,
      status TEXT DEFAULT 'pending',
      http_status INTEGER,
      error_message TEXT,
      suppression_reason TEXT,
      sent_at TEXT,
      clicked_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_notif_log_user ON notification_log(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notif_log_type_status ON notification_log(type, status);

    CREATE TABLE IF NOT EXISTS scheduled_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      template_id INTEGER,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      sent_at TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sched_notif_due ON scheduled_notifications(status, scheduled_at);

    -- Email notification tables (migration v42)
    CREATE TABLE IF NOT EXISTS email_preferences (
      user_id TEXT PRIMARY KEY,
      email_enabled INTEGER DEFAULT 0,
      streak_risk INTEGER DEFAULT 0,
      streak_save INTEGER DEFAULT 0,
      inactivity_reminder INTEGER DEFAULT 0,
      weekly_digest INTEGER DEFAULT 0,
      leaderboard_placement INTEGER DEFAULT 0,
      promotional INTEGER DEFAULT 0,
      giveaway_loss INTEGER DEFAULT 1,
      preferred_hour INTEGER DEFAULT 10,
      timezone TEXT DEFAULT 'UTC',
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      subject_template TEXT NOT NULL,
      html_template TEXT NOT NULL,
      text_template TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      template_id INTEGER,
      type TEXT NOT NULL,
      to_address TEXT NOT NULL,
      subject TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      provider_message_id TEXT,
      error_message TEXT,
      sent_at TEXT,
      opened_at TEXT,
      clicked_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_log_user_type
      ON email_log(user_id, type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_log_status
      ON email_log(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_log_provider_id
      ON email_log(provider_message_id) WHERE provider_message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS scheduled_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      template_id INTEGER,
      type TEXT NOT NULL,
      vars_json TEXT,
      scheduled_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      sent_at TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sched_email_due
      ON scheduled_emails(status, scheduled_at);

    CREATE TABLE IF NOT EXISTS email_trigger_config (
      type TEXT PRIMARY KEY,
      is_enabled INTEGER DEFAULT 0,
      cooldown_hours INTEGER NOT NULL,
      threshold_json TEXT,
      template_id INTEGER,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS email_unsubscribes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      type TEXT,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    INSERT OR IGNORE INTO email_trigger_config (type, is_enabled, cooldown_hours, threshold_json)
      VALUES
        ('streak_risk',         0, 72,  '{"streakMin":3}'),
        ('streak_save',         0, 168, '{"streakMin":7}'),
        ('inactivity_reminder', 0, 336, '{"days":7}'),
        ('weekly_digest',       0, 144, '{"weekday":1,"hour":10}'),
        ('leaderboard_placement', 0, 1, '{"topN":3}'),
        ('promotional',         0, 720, NULL),
        ('giveaway_loss',       1, 0,   NULL);

    -- Analytics (migration v43). Mirrored here so tests that exercise the
    -- event pipeline can run against an in-memory DB without bootstrapping
    -- the full production migration chain.
    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY,
      ts_server       INTEGER NOT NULL,
      ts_client       INTEGER,
      visitor_id      TEXT NOT NULL,
      user_id         TEXT,
      session_id      TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      event_name      TEXT NOT NULL,
      path            TEXT,
      referrer        TEXT,
      game_mode       TEXT,
      game_session_id TEXT,
      mp_room_code    TEXT,
      properties      TEXT,
      country         TEXT,
      region          TEXT,
      browser         TEXT,
      os              TEXT,
      device_type     TEXT NOT NULL DEFAULT 'unknown',
      ua_hash         TEXT,
      ip_hash         TEXT,
      ip_salt_version INTEGER NOT NULL DEFAULT 1,
      is_bot          INTEGER NOT NULL DEFAULT 0,
      client_event_id TEXT,
      tab_id          TEXT,
      seq             INTEGER,
      dnt             INTEGER NOT NULL DEFAULT 0,
      is_synthetic    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_visitor_ts ON events(visitor_id, ts_server);
    CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts_server) WHERE user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(event_name, ts_server);
    CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts_server);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON events(visitor_id, client_event_id)
      WHERE client_event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_events_synthetic ON events(is_synthetic) WHERE is_synthetic = 1;

    CREATE TABLE IF NOT EXISTS analytics_sessions (
      id                 TEXT PRIMARY KEY,
      visitor_id         TEXT NOT NULL,
      user_id            TEXT,
      started_at         INTEGER NOT NULL,
      last_event_at      INTEGER NOT NULL,
      ended_at           INTEGER,
      event_count        INTEGER NOT NULL DEFAULT 1,
      page_view_count    INTEGER NOT NULL DEFAULT 0,
      games_started      INTEGER NOT NULL DEFAULT 0,
      games_completed    INTEGER NOT NULL DEFAULT 0,
      signup_occurred    INTEGER NOT NULL DEFAULT 0,
      login_occurred     INTEGER NOT NULL DEFAULT 0,
      entry_path         TEXT,
      entry_referrer     TEXT,
      entry_utm_source   TEXT,
      entry_utm_medium   TEXT,
      entry_utm_campaign TEXT,
      last_utm_source    TEXT,
      exit_path          TEXT,
      country            TEXT,
      browser            TEXT,
      os                 TEXT,
      device_type        TEXT NOT NULL DEFAULT 'unknown',
      is_returning       INTEGER NOT NULL DEFAULT 0,
      bounced            INTEGER,
      is_bot             INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_asessions_visitor ON analytics_sessions(visitor_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_asessions_started ON analytics_sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_asessions_open ON analytics_sessions(ended_at) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS visitor_profile (
      visitor_id              TEXT PRIMARY KEY,
      user_id                 TEXT,
      first_seen_at           INTEGER NOT NULL,
      last_seen_at            INTEGER NOT NULL,
      current_session_id      TEXT,
      current_session_started INTEGER,
      total_sessions          INTEGER NOT NULL DEFAULT 0,
      total_events            INTEGER NOT NULL DEFAULT 0,
      total_page_views        INTEGER NOT NULL DEFAULT 0,
      total_games_started     INTEGER NOT NULL DEFAULT 0,
      total_games_completed   INTEGER NOT NULL DEFAULT 0,
      total_time_ms           INTEGER NOT NULL DEFAULT 0,
      ever_registered         INTEGER NOT NULL DEFAULT 0,
      ever_played             INTEGER NOT NULL DEFAULT 0,
      last_session_bounced    INTEGER,
      first_country           TEXT,
      first_device_type       TEXT,
      is_bot                  INTEGER NOT NULL DEFAULT 0,
      dnt                     INTEGER
    );

    CREATE TABLE IF NOT EXISTS visitor_aliases (
      visitor_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      merged_at  INTEGER NOT NULL,
      PRIMARY KEY (visitor_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_aliases_user ON visitor_aliases(user_id);

    CREATE TABLE IF NOT EXISTS analytics_hourly (
      hour_bucket        INTEGER NOT NULL,
      device_type        TEXT NOT NULL,
      is_logged_in       INTEGER NOT NULL,
      country            TEXT NOT NULL DEFAULT 'unknown',
      acquisition_source TEXT NOT NULL DEFAULT 'unknown',
      sessions           INTEGER NOT NULL DEFAULT 0,
      new_sessions       INTEGER NOT NULL DEFAULT 0,
      bounced_sessions   INTEGER NOT NULL DEFAULT 0,
      events_count       INTEGER NOT NULL DEFAULT 0,
      page_views         INTEGER NOT NULL DEFAULT 0,
      games_started      INTEGER NOT NULL DEFAULT 0,
      games_completed    INTEGER NOT NULL DEFAULT 0,
      signups            INTEGER NOT NULL DEFAULT 0,
      logins             INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour_bucket, device_type, is_logged_in, country, acquisition_source)
    );

    CREATE TABLE IF NOT EXISTS visitor_attribution (
      visitor_id      TEXT PRIMARY KEY,
      utm_source      TEXT NOT NULL,
      utm_medium      TEXT,
      utm_campaign    TEXT,
      utm_content     TEXT,
      utm_term        TEXT,
      landing_page    TEXT,
      referrer        TEXT,
      first_seen_at   TEXT NOT NULL,
      first_game_at   TEXT,
      first_game_type TEXT,
      first_game_mode TEXT,
      games_played    INTEGER NOT NULL DEFAULT 0,
      claimed_user_id TEXT,
      claimed_at      TEXT
    );
  `);

  // Add PU columns to products table (in test db they're part of base schema)
  // These columns are added via migration v13 in production
  try {
    db.exec(`ALTER TABLE products ADD COLUMN pu_enriched INTEGER DEFAULT 0`);
    db.exec(`ALTER TABLE products ADD COLUMN pu_enriched_at TEXT`);
    db.exec(`ALTER TABLE products ADD COLUMN pu_summary TEXT`);
    db.exec(`ALTER TABLE products ADD COLUMN pu_history TEXT`);
  } catch {
    // Columns may already exist
  }

  return db;
}

/**
 * Seed a test database with sample products.
 *
 * @param db - Database instance.
 * @param count - Number of products to insert.
 * @param options - Optional overrides for category and price range.
 */
export function seedProducts(
  db: DatabaseType,
  count: number,
  options?: { category?: string; priceRange?: [number, number]; manufacturer?: string }
): void {
  const category = options?.category || "Electronics";
  const manufacturer = options?.manufacturer || null;
  const [minPrice, maxPrice] = options?.priceRange || [500, 50000];
  const insert = db.prepare(
    "INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active, manufacturer) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
  );

  const seed = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const price = minPrice + Math.floor(Math.random() * (maxPrice - minPrice));
      insert.run(
        `B0${String(i).padStart(8, "0")}`,
        `Test Product ${i + 1}`,
        `https://example.com/img${i}.jpg`,
        `Description for product ${i + 1}`,
        price,
        category,
        manufacturer
      );
    }
  });
  seed();
}

/**
 * Seed products with diverse categories, manufacturers, and titles for pairing/fingerprint tests.
 *
 * @param db - Database instance.
 * @param count - Minimum number of products to create (actual count may be slightly higher).
 */
export function seedDiverseProducts(db: DatabaseType, count: number): void {
  const items = [
    { title: "Wireless Bluetooth Headphones", category: "Electronics", manufacturer: "Sony", price: 7999 },
    { title: "Noise Cancelling Wireless Earbuds", category: "Electronics", manufacturer: "Bose", price: 12999 },
    { title: "KitchenAid Stand Mixer", category: "Home & Kitchen", manufacturer: "KitchenAid", price: 34999 },
    { title: "Instant Pot Pressure Cooker", category: "Home & Kitchen", manufacturer: "Instant Pot", price: 8999 },
    { title: "Nike Running Shoes", category: "Sports & Outdoors", manufacturer: "Nike", price: 11999 },
    { title: "Yoga Mat Premium Non-Slip", category: "Sports & Outdoors", manufacturer: "Manduka", price: 6999 },
    { title: "LEGO Star Wars Millennium Falcon", category: "Toys & Games", manufacturer: "LEGO", price: 15999 },
    { title: "Board Game Settlers of Catan", category: "Toys & Games", manufacturer: "Catan Studio", price: 4499 },
    { title: "Anti-Aging Face Cream", category: "Beauty & Personal Care", manufacturer: "Olay", price: 2899 },
    { title: "Organic Shampoo Conditioner Set", category: "Beauty & Personal Care", manufacturer: "Pureology", price: 5999 },
    { title: "Heavy Duty Power Drill", category: "Tools & Home Improvement", manufacturer: "DeWalt", price: 14999 },
    { title: "Cordless Impact Wrench", category: "Tools & Home Improvement", manufacturer: "Milwaukee", price: 19999 },
    { title: "Premium Dog Food Grain Free", category: "Pet Supplies", manufacturer: "Blue Buffalo", price: 5499 },
    { title: "Automatic Cat Feeder Timer", category: "Pet Supplies", manufacturer: "PetSafe", price: 6999 },
    { title: "Baby Stroller Lightweight Compact", category: "Baby & Kids", manufacturer: "Graco", price: 24999 },
    { title: "Organic Baby Formula Powder", category: "Baby & Kids", manufacturer: "Similac", price: 3499 },
  ];

  const insert = db.prepare(
    "INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active, manufacturer) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
  );

  const seed = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const item = items[i % items.length];
      const suffix = i >= items.length ? ` V${Math.floor(i / items.length) + 1}` : "";
      insert.run(
        `B1${String(i).padStart(8, "0")}`,
        `${item.title}${suffix}`,
        `https://example.com/diverse${i}.jpg`,
        `Description for ${item.title}`,
        item.price + Math.floor(Math.random() * 2000) - 1000,
        item.category,
        item.manufacturer
      );
    }
  });
  seed();
}

/**
 * Seed user product view records for testing per-user product memory.
 *
 * @param db - Database instance.
 * @param userId - The user ID.
 * @param productIds - Array of product IDs the user has seen.
 * @param sessionId - The game session ID.
 */
export function seedUserProductViews(
  db: DatabaseType,
  userId: string,
  productIds: number[],
  sessionId: string
): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO user_product_views (user_id, product_id, session_id, seen_at) VALUES (?, ?, ?, ?)"
  );
  const seed = db.transaction(() => {
    for (const pid of productIds) {
      insert.run(userId, pid, sessionId, now);
    }
  });
  seed();
}

/**
 * Seed an admin user for testing.
 *
 * @param db - Database instance.
 * @param username - Admin username.
 * @param password - Admin password (will be hashed).
 * @returns The created admin user id.
 */
export function seedAdminUser(
  db: DatabaseType,
  username: string = "testadmin",
  password: string = "testpassword123",
  canUseExtension: boolean = false,
  totpEnabled: boolean = true,
): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(password, 4); // low rounds for test speed
  db.prepare(
    `INSERT INTO admin_users (id, username, password_hash, created_at, updated_at, is_active, can_use_extension, totp_enabled)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, username.toLowerCase(), hash, now, now, canUseExtension ? 1 : 0, totpEnabled ? 1 : 0);
  return id;
}

/**
 * Seed a user account for testing.
 *
 * @param db - Database instance.
 * @param username - Username.
 * @param email - Email address.
 * @param password - Password (will be hashed).
 * @returns The created user id.
 */
export function seedUser(
  db: DatabaseType,
  username: string = "testuser",
  email: string = "test@example.com",
  password: string = "testpassword123"
): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(password, 4); // low rounds for test speed
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(id, username, username.toLowerCase(), email.toLowerCase(), hash, now, now);
  return id;
}

/**
 * Create an in-memory SQLite database with the manufacturer contacts schema.
 *
 * @returns A new contacts database instance for testing.
 */
export function createTestContactsDb(): DatabaseType {
  const db = new Database(":memory:");
  createContactsDb(db);
  return db;
}

/**
 * Seed a manufacturer into the contacts database.
 *
 * @param db - Contacts database instance.
 * @param name - Manufacturer name.
 * @param productCount - Number of products.
 * @returns The inserted manufacturer's ID.
 */
export function seedManufacturer(
  db: DatabaseType,
  name: string,
  productCount: number = 5
): number {
  const manufacturer = insertManufacturer(db, name, productCount);
  return manufacturer.id;
}

/**
 * Seed a contact for a manufacturer.
 *
 * @param db - Contacts database instance.
 * @param manufacturerId - Manufacturer ID.
 * @param data - Contact input data.
 * @returns The inserted contact's ID.
 */
export function seedContact(
  db: DatabaseType,
  manufacturerId: number,
  data: Partial<ContactInput> = {}
): number {
  const contact = insertContact(db, manufacturerId, {
    contactType: data.contactType ?? "general",
    confidence: data.confidence ?? "medium",
    email: data.email,
    phone: data.phone,
    contactPageUrl: data.contactPageUrl,
    sourceUrl: data.sourceUrl,
    notes: data.notes,
  });
  return contact.id;
}

/**
 * Seed products with varied manufacturers into the main database.
 *
 * @param db - Main game database instance.
 * @param count - Number of products to create.
 */
export function seedProductsWithManufacturers(db: DatabaseType, count: number): void {
  const manufacturers = ["Sony", "Nike", "Samsung", "Apple", "LG", "Bose", "DeWalt", "LEGO"];
  const categories = ["Electronics", "Sports & Outdoors", "Home & Kitchen", "Toys & Games"];

  const insert = db.prepare(
    "INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active, manufacturer) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
  );

  const seed = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const mfg = manufacturers[i % manufacturers.length];
      const cat = categories[i % categories.length];
      insert.run(
        `B2${String(i).padStart(8, "0")}`,
        `${mfg} Product ${i + 1}`,
        `https://example.com/mfg${i}.jpg`,
        `Description for ${mfg} product`,
        1000 + Math.floor(Math.random() * 50000),
        cat,
        mfg
      );
    }
  });
  seed();
}

/**
 * Seed PU materials for testing.
 *
 * @param db - Database instance.
 * @param count - Number of materials to create.
 */
export function seedPUMaterials(db: DatabaseType, count: number): number[] {
  const materials = [
    { name: "Aluminum", category: "Metal", description: "Lightweight metal" },
    { name: "Polycarbonate", category: "Plastic", description: "Durable plastic" },
    { name: "Lithium", category: "Metal", description: "Battery metal" },
    { name: "Cotton", category: "Textile", description: "Natural fiber" },
    { name: "Silicon", category: "Semiconductor", description: "Chip material" },
  ];
  const insert = db.prepare(
    "INSERT INTO pu_materials (name, category, description) VALUES (?, ?, ?)"
  );
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const m = materials[i % materials.length];
    const suffix = i >= materials.length ? ` ${Math.floor(i / materials.length) + 1}` : "";
    const info = insert.run(`${m.name}${suffix}`, m.category, m.description);
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
}

/**
 * Seed a PU company for testing.
 *
 * @param db - Database instance.
 * @param name - Company name.
 * @returns The inserted company ID.
 */
export function seedPUCompany(
  db: DatabaseType,
  name: string,
  options?: { website?: string; headquarters?: string }
): number {
  const info = db.prepare(
    `INSERT INTO pu_companies (name, website, headquarters) VALUES (?, ?, ?)`
  ).run(name, options?.website ?? null, options?.headquarters ?? null);
  return Number(info.lastInsertRowid);
}

/**
 * Seed a PU location for testing.
 *
 * @param db - Database instance.
 * @param name - Location name.
 * @param country - Country name.
 * @returns The inserted location ID.
 */
export function seedPULocation(
  db: DatabaseType,
  name: string,
  country: string,
  options?: { latitude?: number; longitude?: number }
): number {
  const info = db.prepare(
    `INSERT INTO pu_locations (name, country, latitude, longitude) VALUES (?, ?, ?, ?)`
  ).run(name, country, options?.latitude ?? null, options?.longitude ?? null);
  return Number(info.lastInsertRowid);
}

/**
 * Seed analytics test data: game sessions, mp rooms, and game rounds.
 *
 * @param db - Database instance.
 */
export function seedAnalyticsData(db: DatabaseType): void {
  // Use the admin timezone (PST/PDT) for bucketing because analytics.getGamesByDay
  // and friends bucket by ADMIN_TIMEZONE. Stamping with UTC "today" caused the
  // suite to go flaky in the UTC/PST boundary window (~midnight UTC) where UTC
  // has already rolled over but PST hasn't — the seed rows then land in a PST
  // day that's outside the query's 30-day window.
  const nowIso = new Date().toISOString();
  const today = tzDateString(nowIso, ADMIN_TIMEZONE);
  const yesterday = tzDateString(
    new Date(Date.now() - 86400000).toISOString(),
    ADMIN_TIMEZONE,
  );

  // Ensure we have some products
  const existing = db.prepare("SELECT COUNT(*) as cnt FROM products").get() as { cnt: number };
  if (existing.cnt === 0) {
    seedProducts(db, 10, { category: "Electronics" });
    seedProducts(db, 5, { category: "Home & Kitchen" });
  }

  // Single-player sessions
  const sessions = [
    { id: "sp-1", mode: "classic", score: 5000, startedAt: `${today}T10:00:00Z`, completedAt: `${today}T10:05:00Z` },
    { id: "sp-2", mode: "classic", score: 7000, startedAt: `${today}T11:00:00Z`, completedAt: `${today}T11:05:00Z` },
    { id: "sp-3", mode: "higher-lower", score: 3000, startedAt: `${yesterday}T09:00:00Z`, completedAt: `${yesterday}T09:05:00Z` },
    { id: "sp-4", mode: "classic", score: 0, startedAt: `${today}T12:00:00Z`, completedAt: null },
  ];

  const insertSession = db.prepare(
    `INSERT INTO game_sessions (id, current_round, total_score, started_at, completed_at, game_mode)
     VALUES (?, 10, ?, ?, ?, ?)`
  );
  for (const s of sessions) {
    insertSession.run(s.id, s.score, s.startedAt, s.completedAt, s.mode);
  }

  // Game rounds with product references
  const productIds = (db.prepare("SELECT id FROM products LIMIT 5").all() as { id: number }[]).map((r) => r.id);
  const insertRound = db.prepare(
    `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const s of sessions) {
    for (let r = 1; r <= 3; r++) {
      insertRound.run(s.id, r, productIds[r % productIds.length], 2000, 500, s.startedAt);
    }
  }

  // Multiplayer rooms.
  //
  // The active-rooms admin query (`routes/admin.ts` getActiveRooms) filters
  // on `COALESCE(last_activity_at, created_at) >= datetime('now', '-2 hours')`.
  // Stamping last_activity_at as `${today}T10:00:00Z` made the test
  // time-of-day flaky: it only passed when CI happened to run within the
  // 10am-12pm UTC window. Stamp the active room's last_activity_at as
  // SQL `datetime('now')` so it's always inside the 2h window regardless
  // of when the test runs. Created_at can stay symbolic — the recency
  // filter only looks at last_activity_at.
  const rooms = [
    { code: "AAAA", mode: "classic", status: "playing", createdAt: `${today}T10:00:00Z`, finishedAt: null, useLiveActivity: true },
    { code: "BBBB", mode: "comparison", status: "finished", createdAt: `${yesterday}T08:00:00Z`, finishedAt: `${yesterday}T08:30:00Z`, useLiveActivity: false },
  ];
  const insertRoomLive = db.prepare(
    `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, created_at, finished_at, last_activity_at)
     VALUES (?, 'host-1', ?, ?, 1, 10, ?, ?, datetime('now'))`
  );
  const insertRoomStatic = db.prepare(
    `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, current_round, total_rounds, created_at, finished_at, last_activity_at)
     VALUES (?, 'host-1', ?, ?, 1, 10, ?, ?, ?)`
  );
  for (const r of rooms) {
    if (r.useLiveActivity) {
      insertRoomLive.run(r.code, r.mode, r.status, r.createdAt, r.finishedAt);
    } else {
      insertRoomStatic.run(r.code, r.mode, r.status, r.createdAt, r.finishedAt, r.finishedAt || r.createdAt);
    }
  }

  // MP players
  const insertPlayer = db.prepare(
    `INSERT INTO mp_players (id, room_code, display_name, avatar, token, is_host, total_score, joined_at)
     VALUES (?, ?, ?, 'wizard', ?, ?, 0, ?)`
  );
  insertPlayer.run("host-1", "AAAA", "Host", "token-host-1", 1, `${today}T10:00:00Z`);
  insertPlayer.run("p2", "AAAA", "Player2", "token-p2", 0, `${today}T10:01:00Z`);
  insertPlayer.run("p3", "BBBB", "Player3", "token-p3", 1, `${yesterday}T08:00:00Z`);
}
