import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  LeaderboardAvailability,
  LeaderboardGameType,
  LeaderboardPeriod,
  LifetimeLeaderboardEntry,
  LongestStreakLeaderboardEntry,
  PeriodLeaderboardEntry,
} from "@price-game/shared";
import {
  getLeaderboardAvailability,
  getLeaderboardV2,
  getLongestStreakLeaderboard,
} from "../api/client";
import PlayerProfileModal from "../components/PlayerProfileModal";
import AvatarIcon from "../components/multiplayer/AvatarIcon";
import RankBadge from "../components/RankBadge";

interface LeaderboardPageProps {
  onBack: () => void;
  openUsername?: string;
  /** When true, the back button says "Back to Game" instead of "Back". */
  hasActiveGame?: boolean;
}

type LeaderboardTab = "lifetime" | "streak";

const PAGE_SIZE = 50;
const STREAK_LIMIT = 50;
const VALID_PERIODS: readonly LeaderboardPeriod[] = ["day", "week", "month", "all"];
const VALID_GAME_TYPES: readonly LeaderboardGameType[] = ["all", "sp", "mp"];

/**
 * Row shape after normalizing between the two leaderboard response types.
 * `getLeaderboardV2` returns `LifetimeLeaderboardEntry` for period="all"
 * and `PeriodLeaderboardEntry` for bounded periods — different field names
 * (`lifetimeScore` vs `score`), same semantics.
 */
interface ScoreRow {
  rank: number;
  username: string;
  score: number;
  totalGames: number;
  avatar: LifetimeLeaderboardEntry["avatar"];
}

function normalizeScoreRow(
  entry: LifetimeLeaderboardEntry | PeriodLeaderboardEntry,
): ScoreRow {
  const score = "lifetimeScore" in entry ? entry.lifetimeScore : entry.score;
  return {
    rank: entry.rank,
    username: entry.username,
    score,
    totalGames: entry.totalGames,
    avatar: entry.avatar,
  };
}

function readPeriodParam(raw: string | null): LeaderboardPeriod {
  return raw && (VALID_PERIODS as readonly string[]).includes(raw)
    ? (raw as LeaderboardPeriod)
    : "all";
}

function readGameTypeParam(raw: string | null): LeaderboardGameType {
  return raw && (VALID_GAME_TYPES as readonly string[]).includes(raw)
    ? (raw as LeaderboardGameType)
    : "all";
}

function readPageParam(raw: string | null): number {
  if (!raw) return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * Build a sparse page-number list for the pagination control.
 *
 * Always includes page 1, the last page, and a ±1 window around the
 * current page. Inserts an "ellipsis" sentinel wherever the displayed
 * numbers skip a gap, so the rendered control reads e.g.
 * `1 … 5 6 7 … 42` for current=6, total=42.
 */
function buildPageList(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 1) return [1];
  const pages = new Set<number>([1, total]);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | "ellipsis")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push("ellipsis");
    out.push(sorted[i]);
  }
  return out;
}

const SCORE_COLUMN_LABEL: Record<LeaderboardPeriod, string> = {
  all: "Lifetime Score",
  month: "Score (30d)",
  week: "Score (7d)",
  day: "Score (24h)",
};

const PERIOD_LABEL: Record<LeaderboardPeriod, string> = {
  all: "All Time",
  month: "Month",
  week: "Week",
  day: "Day",
};

const GAME_TYPE_LABEL: Record<LeaderboardGameType, string> = {
  all: "All",
  sp: "Solo",
  mp: "Multiplayer",
};

/**
 * Leaderboard page (v2) — ranks registered players across two boards:
 * score (with optional day/week/month rolling-window filters and an
 * SP/MP/All game-type slice) and longest daily-challenge streak. A tab
 * row switches between the two views; the streak board is lazy-loaded
 * on first visit.
 *
 * Within the score tab:
 *  - A game-type chip group (All / Solo / Multiplayer) slices the ranking
 *    by `user_game_history.game_type`. "All" is the default and preserves
 *    the canonical combined view (ranked by `users.lifetime_score`).
 *  - A period pill row filters the ranking to a rolling window. Periods
 *    with zero players are hidden — the up-front availability probe fires
 *    once on mount.
 *
 * Both filters are persisted in the URL (`?period=…&gameType=…`) so a
 * shared link reproduces the same view. The default values are omitted
 * from the URL to keep the canonical view's URL clean.
 *
 * Clicking a username opens the PlayerProfileModal.
 * When `openUsername` is set, the modal opens automatically for that user.
 */
export default function LeaderboardPage({ onBack, openUsername, hasActiveGame }: LeaderboardPageProps) {
  const [activeTab, setActiveTab] = useState<LeaderboardTab>("lifetime");
  const [searchParams, setSearchParams] = useSearchParams();
  const period = useMemo(
    () => readPeriodParam(searchParams.get("period")),
    [searchParams],
  );
  const gameType = useMemo(
    () => readGameTypeParam(searchParams.get("gameType")),
    [searchParams],
  );
  const page = useMemo(
    () => readPageParam(searchParams.get("page")),
    [searchParams],
  );

  const [entries, setEntries] = useState<ScoreRow[]>([]);
  const [total, setTotal] = useState(0);
  const [streakEntries, setStreakEntries] = useState<LongestStreakLeaderboardEntry[]>([]);
  const [availability, setAvailability] = useState<LeaderboardAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [streakLoading, setStreakLoading] = useState(false);
  const [streakLoaded, setStreakLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streakError, setStreakError] = useState<string | null>(null);

  // Persist the currently-open profile username in `history.state` so
  // navigating to a recap (/recap/:id) and hitting the browser back button
  // restores the leaderboard with that player's profile re-opened instead
  // of dropping the user on a bare leaderboard.
  const [profileUsername, setProfileUsername] = useState<string | null>(() => {
    if (openUsername) return openUsername;
    if (typeof window !== "undefined") {
      const saved = (window.history.state as { leaderboardProfile?: string } | null)?.leaderboardProfile;
      if (saved) return saved;
    }
    return null;
  });

  function openProfile(username: string) {
    const current = (window.history.state as { leaderboardProfile?: string } | null)?.leaderboardProfile;
    if (current !== username) {
      window.history.pushState(
        { ...window.history.state, leaderboardProfile: username },
        "",
      );
    }
    setProfileUsername(username);
  }

  /**
   * Close the profile modal and strip `leaderboardProfile` from the current
   * history state via replaceState. Why not history.back()?
   *
   * history.back() pops to the previous entry but leaves the "+profile"
   * entry sitting in the forward stack. If the user later navigates to the
   * leaderboard via a non-pushing path (e.g. the same URL/state), they can
   * end up restoring that forward entry's profile from the stale state.
   * Even when push-navigation truncates forward, the same stale state can
   * leak out via the lazy initializer reading `history.state.leaderboardProfile`
   * at re-mount. Replacing the current entry's state in place is leak-proof:
   * the field is gone everywhere it could be re-read from.
   */
  function closeProfile() {
    setProfileUsername(null);
    const state = (window.history.state ?? {}) as { leaderboardProfile?: string } & Record<string, unknown>;
    if (state.leaderboardProfile !== undefined) {
      const next = { ...state };
      delete next.leaderboardProfile;
      window.history.replaceState(next, "");
    }
  }

  useEffect(() => {
    function handlePopState(e: PopStateEvent) {
      const next = (e.state as { leaderboardProfile?: string } | null)?.leaderboardProfile ?? null;
      setProfileUsername(next);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Availability probe — one fetch on mount. Empty-period pills stay
  // hidden until this resolves, so the initial render doesn't flash a
  // pill that's about to disappear.
  useEffect(() => {
    let cancelled = false;
    getLeaderboardAvailability()
      .then((data) => {
        if (!cancelled) setAvailability(data);
      })
      .catch((err) => {
        // Non-fatal — if availability fails, we fall back to hiding all
        // bounded-period pills (only "All Time" renders). Logged, not surfaced.
        console.error("[leaderboard] availability probe failed:", err);
        if (!cancelled) setAvailability({ day: 0, week: 0, month: 0, all: 0 });
      });
    return () => { cancelled = true; };
  }, []);

  // Refetch the score board on period, game-type, or page change. Reset
  // entries + error so stale rows from the previous filter don't blink
  // into the new view while the next page is in flight.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries([]);

    async function load() {
      try {
        const offset = (page - 1) * PAGE_SIZE;
        const data = await getLeaderboardV2(PAGE_SIZE, offset, period, gameType);
        if (!cancelled) {
          setEntries(data.leaderboard.map(normalizeScoreRow));
          setTotal(data.total);
        }
      } catch (err) {
        if (!cancelled) {
          setError("Failed to load leaderboard.");
          console.error(err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [period, gameType, page]);

  // Lazy-load the streak board on first tab switch — avoids an extra
  // request for users who never leave the default "Score" view.
  useEffect(() => {
    if (activeTab !== "streak" || streakLoaded) return;
    let cancelled = false;
    setStreakLoading(true);
    setStreakError(null);

    async function load() {
      try {
        const data = await getLongestStreakLeaderboard(STREAK_LIMIT);
        if (!cancelled) {
          setStreakEntries(data.leaderboard);
          setStreakLoaded(true);
        }
      } catch (err) {
        if (!cancelled) {
          setStreakError("Failed to load streak leaderboard.");
          console.error(err);
        }
      } finally {
        if (!cancelled) setStreakLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [activeTab, streakLoaded]);

  const setPeriod = useCallback(
    (next: LeaderboardPeriod) => {
      const params = new URLSearchParams(searchParams);
      // Omit the default so /leaderboard stays clean for the canonical view.
      if (next === "all") params.delete("period");
      else params.set("period", next);
      // Reset pagination on filter change — page numbers don't carry over
      // between different result sets.
      params.delete("page");
      // Replace rather than push — toggling between pills is a filter
      // change, not a navigation step. Pressing Back should take the
      // user off the leaderboard, not rewind through every pill click.
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setGameType = useCallback(
    (next: LeaderboardGameType) => {
      const params = new URLSearchParams(searchParams);
      if (next === "all") params.delete("gameType");
      else params.set("gameType", next);
      params.delete("page");
      // Same rationale as setPeriod — chip toggling is a filter change.
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setPage = useCallback(
    (next: number) => {
      const params = new URLSearchParams(searchParams);
      if (next <= 1) params.delete("page");
      else params.set("page", String(next));
      // Replace, not push — pagination is part of the same filter view;
      // browser Back should leave the leaderboard, not walk back through
      // page numbers (matches the period/gameType replace pattern).
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamp the URL-driven page if it overshoots the current result set
  // (e.g. user pasted ?page=99 for a 2-page board, or filters narrowed
  // to fewer pages while page=N was set). Done after the fetch so total
  // is up-to-date; replaces silently so the URL self-corrects.
  useEffect(() => {
    if (!loading && page > totalPages) setPage(totalPages);
  }, [loading, page, totalPages, setPage]);

  const scoreColumnLabel = SCORE_COLUMN_LABEL[period];
  const emptyMessage =
    period === "all"
      ? "No scores yet. Be the first to play!"
      : "No scores yet in this period.";

  // Bounded-period pills render only when availability says someone
  // qualifies. "All Time" always renders (it's the canonical view).
  const visiblePeriods: LeaderboardPeriod[] = useMemo(() => {
    const list: LeaderboardPeriod[] = ["all"];
    if (availability) {
      if (availability.month > 0) list.push("month");
      if (availability.week > 0) list.push("week");
      if (availability.day > 0) list.push("day");
    }
    return list;
  }, [availability]);

  return (
    <div className="page leaderboard-page">
      <button className="btn-top leaderboard-back" onClick={onBack}>
        {hasActiveGame ? "\u2190 Back to Game" : "\u2190 Back"}
      </button>
      <h1 className="leaderboard-title">Leaderboard</h1>

      <div className="leaderboard-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === "lifetime"}
          className={`leaderboard-tab${activeTab === "lifetime" ? " leaderboard-tab-active" : ""}`}
          onClick={() => setActiveTab("lifetime")}
        >
          Score
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "streak"}
          className={`leaderboard-tab${activeTab === "streak" ? " leaderboard-tab-active" : ""}`}
          onClick={() => setActiveTab("streak")}
        >
          Longest Streak
        </button>
      </div>

      {activeTab === "lifetime" && (
        <>
          <div
            className="leaderboard-game-types"
            role="tablist"
            aria-label="Game type"
          >
            {VALID_GAME_TYPES.map((g) => (
              <button
                key={g}
                role="tab"
                aria-selected={gameType === g}
                className={`leaderboard-game-type-chip${gameType === g ? " leaderboard-game-type-chip-active" : ""}`}
                onClick={() => setGameType(g)}
              >
                {GAME_TYPE_LABEL[g]}
              </button>
            ))}
          </div>

          {availability && visiblePeriods.length > 1 && (
            <div className="leaderboard-periods" role="tablist" aria-label="Time period">
              {visiblePeriods.map((p) => (
                <button
                  key={p}
                  role="tab"
                  aria-selected={period === p}
                  className={`leaderboard-period-pill${period === p ? " leaderboard-period-pill-active" : ""}`}
                  onClick={() => setPeriod(p)}
                >
                  {PERIOD_LABEL[p]}
                </button>
              ))}
            </div>
          )}

          {loading && <div className="loading">Loading leaderboard...</div>}
          {error && <p className="error-message">{error}</p>}

          {!loading && !error && entries.length === 0 && (
            <p className="empty-message">{emptyMessage}</p>
          )}

          {!loading && entries.length > 0 && (
            <>
              <table className="leaderboard-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Player</th>
                    <th>{scoreColumnLabel}</th>
                    <th>Games</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr
                      key={`${entry.rank}-${entry.username}`}
                      className={entry.rank <= 3 ? `rank-${entry.rank}` : ""}
                    >
                      <td className="rank-cell">
                        <RankBadge rank={entry.rank} variant="lifetime" />
                      </td>
                      <td>
                        <button
                          className="btn-link leaderboard-username"
                          onClick={() => openProfile(entry.username)}
                        >
                          {entry.avatar && <AvatarIcon avatar={entry.avatar} size={40} />}
                          <span className="leaderboard-username-text">{entry.username}</span>
                        </button>
                      </td>
                      <td className="score-cell">
                        {entry.score.toLocaleString()}
                      </td>
                      <td className="games-cell">{entry.totalGames}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {totalPages > 1 && (
                <nav
                  className="leaderboard-pagination"
                  role="navigation"
                  aria-label="Leaderboard pagination"
                >
                  <button
                    className="leaderboard-page-btn leaderboard-page-prev"
                    onClick={() => setPage(page - 1)}
                    disabled={page <= 1}
                    aria-label="Previous page"
                  >
                    {"‹ Prev"}
                  </button>
                  {buildPageList(page, totalPages).map((entry, i) =>
                    entry === "ellipsis" ? (
                      <span
                        key={`e-${i}`}
                        className="leaderboard-page-ellipsis"
                        aria-hidden="true"
                      >
                        {"…"}
                      </span>
                    ) : (
                      <button
                        key={entry}
                        className={`leaderboard-page-btn${entry === page ? " leaderboard-page-btn-active" : ""}`}
                        onClick={() => setPage(entry)}
                        aria-current={entry === page ? "page" : undefined}
                        aria-label={`Page ${entry}`}
                      >
                        {entry}
                      </button>
                    ),
                  )}
                  <button
                    className="leaderboard-page-btn leaderboard-page-next"
                    onClick={() => setPage(page + 1)}
                    disabled={page >= totalPages}
                    aria-label="Next page"
                  >
                    {"Next ›"}
                  </button>
                </nav>
              )}
            </>
          )}
        </>
      )}

      {activeTab === "streak" && (
        <>
          {streakLoading && <div className="loading">Loading streaks...</div>}
          {streakError && <p className="error-message">{streakError}</p>}

          {!streakLoading && !streakError && streakEntries.length === 0 && (
            <p className="empty-message">No streaks yet. Play the daily challenge!</p>
          )}

          {!streakLoading && streakEntries.length > 0 && (
            <table className="leaderboard-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Player</th>
                  <th>Longest Streak</th>
                  <th>Current</th>
                </tr>
              </thead>
              <tbody>
                {streakEntries.map((entry) => (
                  <tr
                    key={`${entry.rank}-${entry.username}`}
                    className={entry.rank <= 3 ? `rank-${entry.rank}` : ""}
                  >
                    <td className="rank-cell">
                      <RankBadge rank={entry.rank} variant="streak" />
                    </td>
                    <td>
                      <button
                        className="btn-link leaderboard-username"
                        onClick={() => openProfile(entry.username)}
                      >
                        {entry.avatar && <AvatarIcon avatar={entry.avatar} size={40} />}
                        <span className="leaderboard-username-text">{entry.username}</span>
                      </button>
                    </td>
                    <td className="score-cell">
                      {entry.longestStreak.toLocaleString()}
                    </td>
                    <td className="games-cell">
                      {entry.currentStreak.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {profileUsername && (
        <PlayerProfileModal
          username={profileUsername}
          onClose={closeProfile}
        />
      )}
    </div>
  );
}
