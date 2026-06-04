/**
 * Round-outcome derivation — turns a `RoundResultsPayload` plus the
 * bot's identity into the small event shape the broadcast overlay
 * panels consume.
 *
 * The overlay distinguishes three buckets:
 *   - "correct"   → score above the per-mode "good" threshold
 *   - "partial"   → score > 0 but below the threshold
 *   - "incorrect" → score === 0
 *
 * For the MP bucket boundary we use **half of the highest player score
 * in the round**: a generous threshold that flags any reasonably-close
 * guess as correct against the round's leader. For solo the threshold
 * is grounded against the per-mode maximum (`getPerRoundMaxScore`)
 * instead, matching the share-grid tier boundary and the canonical
 * `WIN_RATIO_THRESHOLD = 0.5` the player-facing UI uses for streak
 * accounting in `winRecord.ts`.
 *
 * If the bot's `playerId` is unknown (server didn't echo, MP rejoin
 * before `setMyPlayerId` lands, etc.) the helper falls back to the
 * persona-name match, then to the first entry in `playerResults`.
 *
 * In practice this function only fires on MP rounds — solo plays
 * never emit `round_end` and use `deriveSoloOutcome` (HTTP body)
 * instead. The vestigial "solo" branches inside still work as a
 * defensive fallback if a future caller misroutes a solo payload
 * here, but they grade against `bestScore/2` (= the bot's own score
 * over 2 in a one-player payload), which is unrelated to the
 * canonical `WIN_RATIO_THRESHOLD` solo grading and would silently
 * over-credit. Add `mode` and route through `deriveSoloOutcome` if
 * that pathway ever becomes load-bearing.
 */

import type { GameMode, RoundResultsPayload } from "@price-game/shared";
import { getPerRoundMaxScore, WIN_RATIO_THRESHOLD } from "@price-game/shared";

export interface RoundOutcomeView {
  outcome: "correct" | "partial" | "incorrect";
  points: number;
  /** The opposing best score, when available (used by celebration cues). */
  topOpponentScore?: number;
}

/**
 * Compute the bot's `RoundResultEvent`-shaped outcome from the server's
 * `RoundResultsPayload`. Returns null when the payload is empty (no
 * playerResults — happens during teardown / dropped events).
 *
 * @param payload Server-emitted round results.
 * @param myPlayerId Bot's player id, when known. Pass null for solo or
 *                   when the id hasn't been bound yet — the helper
 *                   falls back to `playerResults[0]`.
 * @param personaName Bot's display name, used as a secondary fallback
 *                    when `myPlayerId` is null but the player list
 *                    contains a name match (e.g. MP rejoin before
 *                    `setMyPlayerId` lands).
 */
export function deriveRoundOutcome(
  payload: RoundResultsPayload,
  myPlayerId: string | null,
  personaName: string,
): RoundOutcomeView | null {
  const results = payload.playerResults;
  if (!results || results.length === 0) return null;

  const me = (myPlayerId ? results.find((r) => r.playerId === myPlayerId) : undefined)
    ?? results.find((r) => r.displayName === personaName)
    ?? results[0];

  const others = results.filter((r) => r !== me);
  const topOpponentScore = others.length > 0
    ? Math.max(...others.map((r) => r.score))
    : undefined;

  // Reference: best score in the round (including bot). Half of that
  // is the "correct" threshold. For solo this equals me.score, so
  // "correct" iff me.score > 0.
  const bestScore = Math.max(...results.map((r) => r.score));
  const threshold = bestScore / 2;

  let outcome: RoundOutcomeView["outcome"];
  if (me.score === 0) {
    outcome = "incorrect";
  } else if (me.score >= threshold) {
    outcome = "correct";
  } else {
    outcome = "partial";
  }

  return {
    outcome,
    points: me.score,
    topOpponentScore,
  };
}

/**
 * Solo-mode outcome derivation. Solo plays don't emit Socket.IO
 * `round_end` (those events are MP-only) — the score comes back in
 * the HTTP response to `POST /api/game/:sessionId/guess`. This
 * helper turns that score into the same `RoundOutcomeView` shape
 * `deriveRoundOutcome` produces, so the downstream wins/losses /
 * mood / overlay-event logic in `playwrightDriver` can be
 * transport-agnostic.
 *
 * Grading uses the per-mode max from `getPerRoundMaxScore` so the
 * boundary matches the share-grid `good`/`ok`/`miss` tiers and the
 * canonical solo win threshold the price.game UI uses for player
 * streaks (`WIN_RATIO_THRESHOLD = 0.5` in `winRecord.ts`):
 *   - `score === 0`               → `incorrect`
 *   - `score / max >= 0.5`        → `correct`
 *   - otherwise (`>0` but `<0.5`) → `partial`
 *
 * Pre-fix this routed every positive score to `correct` because solo
 * had no opponents to ground the threshold. That made `moodState.streak`
 * monotonically positive in solo (the bot's heuristic + learned model
 * earn *some* points on virtually every round) — locking mood into
 * `focused`/`elated` and starving the corrective negative-valence
 * branches the mood engine relies on.
 *
 * @param score Score from the solo guess response. Negative / NaN
 *              values are treated as 0 (defensive — the server
 *              shouldn't return those, but this is decorative state
 *              and we don't want a pathological payload to mis-credit
 *              a win).
 * @param mode  Game mode for the round. Drives `getPerRoundMaxScore`
 *              so chain-reaction (max 1313) is graded against its
 *              actual ceiling, not the 1000 default.
 */
export function deriveSoloOutcome(score: number, mode: GameMode): RoundOutcomeView {
  const safeScore = Number.isFinite(score) && score > 0 ? Math.floor(score) : 0;
  if (safeScore === 0) {
    return { outcome: "incorrect", points: 0 };
  }
  const max = getPerRoundMaxScore(mode);
  const outcome: RoundOutcomeView["outcome"] =
    max > 0 && safeScore / max >= WIN_RATIO_THRESHOLD ? "correct" : "partial";
  return { outcome, points: safeScore };
}

/**
 * Map a per-round outcome bucket to the LineEvent the narrator should
 * use for its reactive line. Lives here (next to the outcome
 * derivation) rather than in the driver so the mapping is unit-
 * testable without the driver's full Playwright/observer scaffolding.
 *
 * Mirrors the mood-input mapping inside `attemptRound` so the spoken
 * line agrees with the mood the engine just transitioned to:
 *   correct   → win_correct        (clean win line pool)
 *   partial   → loss_off_a_little  (some points, below threshold)
 *   incorrect → loss_off_a_lot     (zero points)
 *
 * The `win_close` LineEvent stays unused here — it's reserved for a
 * future PR that extends `RoundOutcomeView` with a score-vs-bestScore
 * ratio so we can distinguish "barely cleared the threshold" from a
 * solid `correct`. Until then every `correct` outcome reaches for
 * the same pool, which is still mood-biased.
 *
 * Return type is `LineEvent` (string union) — kept narrow on purpose
 * so a future event addition that should NOT be reactive doesn't
 * accidentally widen the contract here.
 */
export function reactiveLineForOutcome(
  outcome: RoundOutcomeView["outcome"],
): "win_correct" | "loss_off_a_little" | "loss_off_a_lot" {
  if (outcome === "correct") return "win_correct";
  if (outcome === "partial") return "loss_off_a_little";
  return "loss_off_a_lot";
}

/**
 * Decide whether a per-round outcome qualifies for one of the
 * "special" reactive events (bullseye / comeback / streak milestone /
 * personal best). Returns the highest-priority match, or `null` if
 * no special applies — caller falls back to `reactiveLineForOutcome`.
 *
 * Pure / no side effects so the priority logic can be exercised
 * exhaustively in unit tests without standing up the driver.
 *
 * Priority order is intentional:
 *   1. round_bullseye        — score is at/near per-round max
 *   2. comeback              — streak just flipped to positive after
 *                              a meaningful prior negative run
 *   3. streak_milestone      — winning streak crossed a threshold
 *   4. personal_best_round   — round score beats this game's best
 *                              AND we're past the first round
 *
 * Streak milestones gate on `cs.streak > 0` deliberately — the
 * `streak_milestone` line pool is celebratory ("I'm on a HEATER!")
 * and would land as tone-deaf during a losing collapse. Losing
 * streaks already get the right vibe from `loss_off_a_lot` +
 * frustrated/despondent mood lines.
 *
 * `bullseyeFraction` is the fraction of per-round-max score that
 * counts as "perfect"; production uses 0.95 in the driver.
 */
export interface OutcomeSpecialInput {
  readonly roundPoints: number;
  readonly perRoundMaxScore: number;
  readonly bullseyeFraction: number;
  readonly prevStreak: number;
  readonly nextStreak: number;
  readonly streakMilestones: ReadonlySet<number>;
  readonly currentGameBestScore: number;
  readonly currentGameRoundIndex: number;
}
export function pickOutcomeSpecialEvent(input: OutcomeSpecialInput):
  "round_bullseye" | "comeback" | "streak_milestone" | "personal_best_round" | null {
  if (input.perRoundMaxScore > 0
    && input.roundPoints / input.perRoundMaxScore >= input.bullseyeFraction
  ) return "round_bullseye";
  if (input.prevStreak <= -3 && input.nextStreak > 0) return "comeback";
  if (input.nextStreak > 0
    && input.nextStreak > input.prevStreak
    && input.streakMilestones.has(input.nextStreak)
  ) return "streak_milestone";
  if (input.currentGameRoundIndex > 0
    && input.roundPoints > input.currentGameBestScore
  ) return "personal_best_round";
  return null;
}

/**
 * Standings entry shape used by `computeFinalRankEvent`. Matches the
 * subset of `MpStandingsEntry` from `playwrightDriver` — kept local
 * (rather than re-exported) so this helper has no upward dep on the
 * driver module.
 */
export interface FinalRankStanding {
  readonly playerId: string;
  readonly displayName: string;
  readonly totalScore: number;
}
/**
 * Map an MP game's final standings to the `final_rank_*` event the
 * narrator should announce, or `null` when standings are missing /
 * the bot can't be located in them. Identity match precedence:
 * playerId → displayName → first-seat fallback (mirrors
 * `decideMpGameWin` so rank attribution agrees with win attribution).
 *
 * Solo-collapsed standings (length 1) return `null` — there's no
 * rank concept with one seat; the caller already handled the
 * win/loss line for that case.
 *
 * Tie-breaking matches the win rule: ties at the top still count as
 * `final_rank_first`. A bot at the floor with another at the floor
 * still counts as `final_rank_last`.
 */
export function computeFinalRankEvent(
  standings: readonly FinalRankStanding[] | undefined,
  myPlayerId: string | null,
  personaName: string,
): "final_rank_first" | "final_rank_middle" | "final_rank_last" | null {
  if (!standings || standings.length === 0) return null;
  if (standings.length === 1) return null;
  const me = (myPlayerId ? standings.find((s) => s.playerId === myPlayerId) : undefined)
    ?? standings.find((s) => s.displayName === personaName)
    ?? standings[0];
  const myScore = me.totalScore;
  const others = standings.filter((s) => s !== me);
  const anyAbove = others.some((s) => s.totalScore > myScore);
  const anyBelow = others.some((s) => s.totalScore < myScore);
  if (!anyAbove) return "final_rank_first";
  if (!anyBelow) return "final_rank_last";
  return "final_rank_middle";
}

/**
 * Mood polarity bucket (-3 = despondent, +3 = elated) for the
 * mood-shift event picker. `focused` and `neutral` share polarity 0
 * — same-bucket transitions don't fire shift events because they
 * read as cosmetic re-labels rather than affective shifts.
 *
 * Exported for the unit test that pins the ordering against
 * `MOOD_LABELS` in @price-game/shared.
 */
export type MoodLabel = "elated" | "happy" | "confident" | "focused" | "neutral" | "tilted" | "frustrated" | "despondent";
export const MOOD_POLARITY_TABLE: Record<MoodLabel, number> = {
  elated: 3,
  happy: 2,
  confident: 1,
  focused: 0,
  neutral: 0,
  tilted: -1,
  frustrated: -2,
  despondent: -3,
};
const EXTREME_MOOD_LABELS: ReadonlySet<MoodLabel> = new Set<MoodLabel>(["elated", "despondent"]);

/**
 * Decide which `mood_shift_*` / `mood_extreme` event (if any) the
 * narrator should announce given a mood transition. Returns `null`
 * when:
 *   - the resolved label didn't change, OR
 *   - the polarity bucket didn't move (e.g., neutral ↔ focused)
 *
 * Hitting an extreme mood (elated / despondent) returns
 * `mood_extreme` regardless of direction — the line pool already
 * reads as "wow I'm at an edge".
 *
 * Pure (no probability gate, no `Math.random()`) — caller applies
 * the gate so the function stays deterministic for tests.
 */
export function nextMoodShiftEvent(prev: MoodLabel, next: MoodLabel):
  "mood_shift_up" | "mood_shift_down" | "mood_extreme" | null {
  if (prev === next) return null;
  const prevPol = MOOD_POLARITY_TABLE[prev];
  const nextPol = MOOD_POLARITY_TABLE[next];
  if (prevPol === nextPol) return null;
  if (EXTREME_MOOD_LABELS.has(next)) return "mood_extreme";
  return nextPol > prevPol ? "mood_shift_up" : "mood_shift_down";
}

/**
 * Parse a probability-shaped env var into a [0, 1] number with a
 * default. The naive `Number(process.env.X ?? "")` form returns 0
 * for missing / empty env values (which is finite, so a `isFinite`
 * fallback never fires) — this helper guards against that footgun.
 *
 * Used by `STREAMER_IDLE_INTERJECTION_PROB` parsing in the driver.
 */
export function parseProbEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}
