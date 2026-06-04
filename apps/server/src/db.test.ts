import { describe, it, expect } from "vitest";
import { createTestDb } from "./test/dbHelper";

describe("database schema", () => {
  it("creates all expected tables", () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("products");
    expect(tableNames).toContain("game_sessions");
    expect(tableNames).toContain("game_rounds");
    expect(tableNames).toContain("leaderboard");
    expect(tableNames).toContain("mp_rooms");
    expect(tableNames).toContain("mp_players");
    expect(tableNames).toContain("mp_guesses");
    expect(tableNames).toContain("mp_leaderboard");
    expect(tableNames).toContain("user_product_views");
  });

  it("products table has expected columns", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(products)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("id");
    expect(cols).toContain("asin");
    expect(cols).toContain("title");
    expect(cols).toContain("price_cents");
    expect(cols).toContain("category");
    expect(cols).toContain("is_active");
    expect(cols).toContain("image_url");
    expect(cols).toContain("last_used_at");
  });

  it("game_sessions table has mode and round_data columns", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(game_sessions)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("game_mode");
    expect(cols).toContain("round_data");
  });

  it("mp_rooms table has password column", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(mp_rooms)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("password");
  });

  it("enforces foreign keys", () => {
    const db = createTestDb();
    const fk = db.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(fk[0].foreign_keys).toBe(1);
  });

  it("can insert and query products", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO products (asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)"
    ).run("B12345678X", "Test", "url", "desc", 1999, "Electronics");

    const row = db.prepare("SELECT * FROM products WHERE asin = ?").get("B12345678X") as any;
    expect(row).toBeDefined();
    expect(row.title).toBe("Test");
    expect(row.price_cents).toBe(1999);
  });
});

describe("daily challenge schema (migration v32)", () => {
  it("creates daily_puzzles and daily_plays tables", () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("daily_puzzles");
    expect(tableNames).toContain("daily_plays");
  });

  it("daily_puzzles has the expected columns", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(daily_puzzles)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("daily_date");
    expect(cols).toContain("game_mode");
    expect(cols).toContain("product_ids");
    expect(cols).toContain("round_data");
    expect(cols).toContain("salt_version");
    expect(cols).toContain("is_manual_override");
    expect(cols).toContain("created_at");
  });

  it("daily_plays has the expected columns", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(daily_plays)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("id");
    expect(cols).toContain("user_id");
    expect(cols).toContain("session_id");
    expect(cols).toContain("daily_date");
    expect(cols).toContain("game_mode");
    expect(cols).toContain("score");
    expect(cols).toContain("per_round_scores");
    expect(cols).toContain("streak_at_completion");
    expect(cols).toContain("started_at");
    expect(cols).toContain("completed_at");
  });

  it("users table has the new daily streak columns with correct defaults", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(users)") as { name: string; dflt_value: string | null }[];
    const cols = info.reduce((acc, c) => {
      acc[c.name] = c.dflt_value;
      return acc;
    }, {} as Record<string, string | null>);
    expect(cols).toHaveProperty("daily_streak_current");
    expect(cols).toHaveProperty("daily_streak_best");
    expect(cols).toHaveProperty("daily_streak_last_date");
    expect(cols.daily_streak_current).toBe("0");
    expect(cols.daily_streak_best).toBe("0");
  });

  it("game_sessions has is_daily and daily_date columns", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(game_sessions)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("is_daily");
    expect(cols).toContain("daily_date");
  });

  it("daily_plays partial unique index allows multiple anonymous rows for the same date", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at)
       VALUES (NULL, ?, ?, ?, 0, ?)`
    );
    insert.run("session-A", "2026-04-15", "classic", now);
    insert.run("session-B", "2026-04-15", "classic", now);
    // Two anonymous rows for the same date should both succeed.
    const count = db
      .prepare("SELECT COUNT(*) as c FROM daily_plays WHERE daily_date = ?")
      .get("2026-04-15") as { c: number };
    expect(count.c).toBe(2);
  });

  it("daily_plays partial unique index forbids duplicate (user_id, daily_date)", () => {
    const db = createTestDb();
    // Need a real users row because of FK; insert one.
    db.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at)
       VALUES ('u1', 'tester', 'tester', 'test@example.com', 'hash', ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString());

    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    );
    insert.run("u1", "session-1", "2026-04-15", "classic", now);
    expect(() => insert.run("u1", "session-2", "2026-04-15", "classic", now)).toThrow(/UNIQUE/);
  });

  it("daily_plays.session_id has a UNIQUE constraint", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at)
       VALUES (NULL, ?, ?, ?, 0, ?)`
    );
    insert.run("dupe-session", "2026-04-15", "classic", now);
    expect(() => insert.run("dupe-session", "2026-04-16", "classic", now)).toThrow(/UNIQUE/);
  });
});

describe("device-aware notifications schema (migration v40)", () => {
  it("push_subscriptions has a visitor_id column", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(push_subscriptions)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("visitor_id");
  });

  it("daily_plays has a visitor_id column", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(daily_plays)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("visitor_id");
  });

  it("game_sessions has a visitor_id column", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(game_sessions)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("visitor_id");
  });

  it("daily_plays partial unique index forbids duplicate (visitor_id, daily_date)", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, visitor_id)
       VALUES (NULL, ?, ?, ?, 0, ?, ?)`
    );
    insert.run("sess-v1", "2026-04-16", "classic", now, "visitor-A");
    expect(() =>
      insert.run("sess-v2", "2026-04-16", "classic", now, "visitor-A"),
    ).toThrow(/UNIQUE/);
  });

  it("daily_plays partial unique index allows duplicates when visitor_id is NULL", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, visitor_id)
       VALUES (NULL, ?, ?, ?, 0, ?, NULL)`
    );
    insert.run("sess-n1", "2026-04-16", "classic", now);
    // A second NULL-visitor row for the same date must still succeed.
    expect(() => insert.run("sess-n2", "2026-04-16", "classic", now)).not.toThrow();
  });
});

describe("win/loss/streak schema (migration v69)", () => {
  it("users table has the new W/L cache columns with correct defaults", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(users)") as { name: string; dflt_value: string | null }[];
    const cols = info.reduce((acc, c) => {
      acc[c.name] = c.dflt_value;
      return acc;
    }, {} as Record<string, string | null>);
    expect(cols).toHaveProperty("lifetime_wins");
    expect(cols).toHaveProperty("lifetime_losses");
    expect(cols).toHaveProperty("current_streak");
    expect(cols).toHaveProperty("best_win_streak");
    expect(cols).toHaveProperty("is_bot");
    expect(cols.lifetime_wins).toBe("0");
    expect(cols.lifetime_losses).toBe("0");
    expect(cols.current_streak).toBe("0");
    expect(cols.best_win_streak).toBe("0");
    expect(cols.is_bot).toBe("0");
  });

  it("visitor_attribution has the same W/L cache columns", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(visitor_attribution)") as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("lifetime_wins");
    expect(cols).toContain("lifetime_losses");
    expect(cols).toContain("current_streak");
    expect(cols).toContain("best_win_streak");
  });

  it("user_game_history has an is_win column that allows NULL", () => {
    const db = createTestDb();
    const info = db.pragma("table_info(user_game_history)") as {
      name: string;
      notnull: number;
    }[];
    const isWin = info.find((c) => c.name === "is_win");
    expect(isWin).toBeDefined();
    // NULL = "didn't count" (disconnect, solo MP, bot, excluded).
    expect(isWin?.notnull).toBe(0);
  });

  it("current_streak on users accepts negative values", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at, current_streak)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("u-neg", "neg", "neg", "neg@example.com", "h", now, now, -3);
    const row = db
      .prepare("SELECT current_streak FROM users WHERE id = ?")
      .get("u-neg") as { current_streak: number };
    expect(row.current_streak).toBe(-3);
  });
});
