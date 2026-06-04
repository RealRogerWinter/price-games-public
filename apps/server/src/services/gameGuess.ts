/**
 * Product fetching and guess submission for single-player games.
 *
 * Handles all game modes: classic, higher-lower, comparison,
 * closest-without-going-over, price-match, riser, odd-one-out,
 * market-basket, sort-it-out, budget-builder, and chain-reaction.
 */
import db from "../db";
import { DbProduct, toProduct, toProductWithPrice, getProductsByIds, getProductsForRound, getProductsWithPriceForRound } from "./productMapper";
import type { DbSession } from "./gameSession";
import { toGameSession, getSessionTotalRounds } from "./gameSession";
import { cleanupSessionHints } from "./gameHints";
import { scoreGuessForMode, MAX_ARRAY_INPUT_LENGTH } from "./guessScoring";
import { updateStreakOnCompletion, getStreakForUser } from "./dailyStreak";
import { cancelScheduledNotifications, scheduleNotification } from "./notificationScheduler";
import { config } from "../config";
import {
  GameMode,
  GameSession,
  DAILY_TOTAL_ROUNDS,
  COMPARISON_PRODUCTS_PER_ROUND,
  PRICE_MATCH_PRODUCTS_PER_ROUND,
  ODD_ONE_OUT_PRODUCTS_PER_ROUND,
  SORT_IT_OUT_PRODUCTS_PER_ROUND,
  BUDGET_BUILDER_PRODUCTS_PER_ROUND,
  CHAIN_REACTION_PRODUCTS_PER_ROUND,
  ROUND_TIME_SECONDS,
  MP_PRICE_MATCH_TIME_SECONDS,
  MP_MARKET_BASKET_TIME_SECONDS,
  MP_BUDGET_BUILDER_TIME_SECONDS,
  MP_CHAIN_REACTION_TIME_SECONDS,
  type DailyCompletionPayload,
} from "@price-game/shared";

// S6 fix: server-side round start tracking for single-player.
// Maps sessionId -> { round, fetchedAt } so submitGuess can enforce time limits.
const roundFetchTimes = new Map<string, { round: number; fetchedAt: number }>();

// Generous multiplier to account for network latency; prevents blatant abuse
// while not penalizing legitimate players.
const SP_TIMER_GRACE_FACTOR = 2;

/** Clean up fetch time tracking for a completed session. */
export function cleanupSessionTimers(sessionId: string): void {
  roundFetchTimes.delete(sessionId);
}

// Periodic cleanup of stale entries (abandoned sessions >1 hour old)
const TIMER_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of roundFetchTimes) {
    if (now - entry.fetchedAt > TIMER_TTL_MS) {
      roundFetchTimes.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Compute the product IDs for the current round based on game mode. This is
 * the single source of truth for mapping `(mode, roundNum, selected_products,
 * round_data)` → product IDs for a single-player session. Exported so other
 * services (e.g. `historyRecap`) can replay the same mapping when
 * reconstructing historical rounds.
 */
export function getRoundProductIds(
  mode: GameMode,
  selectedIds: number[],
  currentRound: number,
  roundData: Record<string, any> | null,
): number[] {
  const rd = roundData?.[String(currentRound)];

  if (mode === "classic" || mode === "higher-lower" || mode === "closest-without-going-over" || mode === "riser" || mode === "bidding") {
    return [selectedIds[currentRound - 1]];
  }
  if (mode === "comparison") {
    const startIdx = (currentRound - 1) * COMPARISON_PRODUCTS_PER_ROUND;
    return selectedIds.slice(startIdx, startIdx + COMPARISON_PRODUCTS_PER_ROUND);
  }
  if (mode === "price-match") {
    const startIdx = (currentRound - 1) * PRICE_MATCH_PRODUCTS_PER_ROUND;
    return selectedIds.slice(startIdx, startIdx + PRICE_MATCH_PRODUCTS_PER_ROUND);
  }
  if (mode === "odd-one-out") {
    return rd?.productIds || selectedIds.slice(
      (currentRound - 1) * ODD_ONE_OUT_PRODUCTS_PER_ROUND,
      (currentRound - 1) * ODD_ONE_OUT_PRODUCTS_PER_ROUND + ODD_ONE_OUT_PRODUCTS_PER_ROUND
    );
  }
  if (mode === "market-basket") {
    return rd?.productIds || [];
  }
  if (mode === "sort-it-out") {
    return rd?.productIds || selectedIds.slice(
      (currentRound - 1) * SORT_IT_OUT_PRODUCTS_PER_ROUND,
      (currentRound - 1) * SORT_IT_OUT_PRODUCTS_PER_ROUND + SORT_IT_OUT_PRODUCTS_PER_ROUND
    );
  }
  if (mode === "budget-builder") {
    return rd?.productIds || selectedIds.slice(
      (currentRound - 1) * BUDGET_BUILDER_PRODUCTS_PER_ROUND,
      (currentRound - 1) * BUDGET_BUILDER_PRODUCTS_PER_ROUND + BUDGET_BUILDER_PRODUCTS_PER_ROUND
    );
  }
  if (mode === "chain-reaction") {
    return rd?.productIds || selectedIds.slice(
      (currentRound - 1) * CHAIN_REACTION_PRODUCTS_PER_ROUND,
      (currentRound - 1) * CHAIN_REACTION_PRODUCTS_PER_ROUND + CHAIN_REACTION_PRODUCTS_PER_ROUND
    );
  }
  return [selectedIds[currentRound - 1]];
}

export function getSessionProduct(sessionId: string): any {
  const session = db
    .prepare("SELECT * FROM game_sessions WHERE id = ?")
    .get(sessionId) as DbSession | undefined;

  if (!session || session.completed_at) return null;

  // S6 fix: record when the product was fetched for server-side time enforcement
  roundFetchTimes.set(sessionId, { round: session.current_round, fetchedAt: Date.now() });

  const selectedIds: number[] = JSON.parse(session.selected_products);
  const mode = (session.game_mode || "classic") as GameMode;
  const roundData = session.round_data ? JSON.parse(session.round_data) : null;

  if (mode === "comparison") {
    const startIdx = (session.current_round - 1) * COMPARISON_PRODUCTS_PER_ROUND;
    const roundProductIds = selectedIds.slice(startIdx, startIdx + COMPARISON_PRODUCTS_PER_ROUND);
    const products = getProductsForRound(roundProductIds);
    const question = roundData?.[String(session.current_round)]?.question || "most-expensive";
    return { products, question };
  }

  if (mode === "price-match") {
    const startIdx = (session.current_round - 1) * PRICE_MATCH_PRODUCTS_PER_ROUND;
    const roundProductIds = selectedIds.slice(startIdx, startIdx + PRICE_MATCH_PRODUCTS_PER_ROUND);
    const productMap = getProductsByIds(roundProductIds);
    const products = getProductsForRound(roundProductIds, productMap);

    const prices = roundProductIds
      .map((id) => productMap.get(id)?.price_cents)
      .filter((p): p is number => p !== undefined);
    for (let i = prices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [prices[i], prices[j]] = [prices[j], prices[i]];
    }

    return { products, prices };
  }

  if (mode === "odd-one-out") {
    const rd = roundData?.[String(session.current_round)];
    const roundProductIds: number[] = rd?.productIds || selectedIds.slice(
      (session.current_round - 1) * ODD_ONE_OUT_PRODUCTS_PER_ROUND,
      (session.current_round - 1) * ODD_ONE_OUT_PRODUCTS_PER_ROUND + ODD_ONE_OUT_PRODUCTS_PER_ROUND
    );
    return { products: getProductsForRound(roundProductIds) };
  }

  if (mode === "market-basket") {
    const rd = roundData?.[String(session.current_round)];
    const roundProductIds: number[] = rd?.productIds || [];
    const products = getProductsForRound(roundProductIds);
    return { products, itemCount: rd?.itemCount || products.length };
  }

  if (mode === "sort-it-out") {
    const rd = roundData?.[String(session.current_round)];
    const roundProductIds: number[] = rd?.productIds || selectedIds.slice(
      (session.current_round - 1) * SORT_IT_OUT_PRODUCTS_PER_ROUND,
      (session.current_round - 1) * SORT_IT_OUT_PRODUCTS_PER_ROUND + SORT_IT_OUT_PRODUCTS_PER_ROUND
    );
    return { products: getProductsForRound(roundProductIds) };
  }

  if (mode === "budget-builder") {
    const rd = roundData?.[String(session.current_round)];
    const roundProductIds: number[] = rd?.productIds || selectedIds.slice(
      (session.current_round - 1) * BUDGET_BUILDER_PRODUCTS_PER_ROUND,
      (session.current_round - 1) * BUDGET_BUILDER_PRODUCTS_PER_ROUND + BUDGET_BUILDER_PRODUCTS_PER_ROUND
    );
    return { products: getProductsForRound(roundProductIds), budgetCents: rd?.budgetCents || 0 };
  }

  if (mode === "chain-reaction") {
    const rd = roundData?.[String(session.current_round)];
    const roundProductIds: number[] = rd?.productIds || selectedIds.slice(
      (session.current_round - 1) * CHAIN_REACTION_PRODUCTS_PER_ROUND,
      (session.current_round - 1) * CHAIN_REACTION_PRODUCTS_PER_ROUND + CHAIN_REACTION_PRODUCTS_PER_ROUND
    );
    return { products: getProductsForRound(roundProductIds) };
  }

  // Single product modes
  const currentProductId = selectedIds[session.current_round - 1];
  if (currentProductId === undefined) return null;

  const product = db
    .prepare("SELECT * FROM products WHERE id = ?")
    .get(currentProductId) as DbProduct | undefined;

  if (!product) return null;

  if (mode === "higher-lower") {
    const referencePrice = roundData?.[String(session.current_round)]?.referencePrice || 0;
    return { product: toProduct(product), referencePrice };
  }

  if (mode === "riser") {
    const rd = roundData?.[String(session.current_round)];
    return {
      product: toProduct(product),
      maxPriceCents: rd?.maxPriceCents || product.price_cents,
      speedPattern: rd?.speedPattern || "linear",
      durationMs: rd?.durationMs || 8000,
    };
  }

  // Classic or closest
  return toProduct(product);
}

export function submitGuess(sessionId: string, guessData: any): any {
  const session = db
    .prepare("SELECT * FROM game_sessions WHERE id = ?")
    .get(sessionId) as DbSession | undefined;

  if (!session || session.completed_at) return null;

  // Prevent double-submit: check if this round already has a guess
  const existingGuess = db
    .prepare("SELECT id FROM game_rounds WHERE session_id = ? AND round_number = ?")
    .get(sessionId, session.current_round);
  if (existingGuess) return null;

  // Daily challenge: on the FIRST guess of a daily session, attempt to
  // commit a daily_plays row. The partial unique indexes on (user_id, date)
  // and (visitor_id, date) are the real once-per-day guards — the former
  // for logged-in users, the latter for guests/devices. On collision we
  // surface an `already_played` sentinel that the route layer maps to 409.
  // Rows without a user_id OR a visitor_id still bypass both indexes, which
  // matches the pre-v40 anonymous-play behavior.
  if (session.is_daily === 1 && session.current_round === 1) {
    try {
      db.prepare(
        `INSERT INTO daily_plays
           (user_id, session_id, daily_date, game_mode, score, started_at, visitor_id)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      ).run(
        session.user_id ?? null,
        sessionId,
        session.daily_date!,
        session.game_mode ?? "classic",
        new Date().toISOString(),
        session.visitor_id ?? null,
      );
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { error: "already_played" };
      }
      throw err;
    }
  }

  const selectedIds: number[] = JSON.parse(session.selected_products);
  const mode = (session.game_mode || "classic") as GameMode;
  const roundData = session.round_data ? JSON.parse(session.round_data) : null;
  const now = new Date().toISOString();

  // Price-match requires valid assignments object — preserve SP-specific early return
  if (mode === "price-match" && (!guessData?.assignments || typeof guessData.assignments !== "object")) {
    return null;
  }

  // SP defaults invalid higher-lower guesses to "higher" (MP returns score 0)
  const sanitizedGuessData = mode === "higher-lower"
    && guessData && typeof guessData === "object"
    && guessData.guess !== "higher" && guessData.guess !== "lower"
    ? { ...guessData, guess: "higher" }
    : guessData;

  // Compute round-specific product IDs and metadata
  const roundProductIds = getRoundProductIds(mode, selectedIds, session.current_round, roundData);
  const roundMeta = roundData?.[String(session.current_round)] || {};

  // Single product fetch shared by both scoring and response building
  const productMap = getProductsByIds(roundProductIds);

  // Score the guess via the shared dispatcher — single source of truth for all modes
  const sr = scoreGuessForMode(mode, sanitizedGuessData, roundProductIds, roundMeta, productMap);

  // Invalid mode or completely malformed input — reject without advancing the round
  if (sr.mode === "invalid") return null;

  let score = sr.score;

  // Build the DB record and response payload from the scoring result
  let result: any;

  if (sr.mode === "classic") {
    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], sr.guessedPriceCents, score, now);

    result = {
      product: getProductsWithPriceForRound(roundProductIds, productMap)[0],
      guessedPriceCents: sr.guessedPriceCents,
      score,
      pctOff: sr.pctOff,
    };
  } else if (sr.mode === "higher-lower") {
    const referencePrice = roundMeta.referencePrice || 0;

    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], null, score, now, JSON.stringify({ guess: sr.guess, referencePrice }));

    result = {
      product: getProductsWithPriceForRound(roundProductIds, productMap)[0],
      referencePrice,
      guess: sr.guess,
      correct: sr.correct,
      score,
    };
  } else if (sr.mode === "comparison") {
    const question = roundMeta.question || "most-expensive";

    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, sr.correctProductId, null, score, now, JSON.stringify({ guessedProductId: sr.guessedProductId, question }));

    result = {
      products: getProductsWithPriceForRound(roundProductIds, productMap),
      question,
      correctProductId: sr.correctProductId,
      guessedProductId: sr.guessedProductId,
      correct: sr.correct,
      score,
    };
  } else if (sr.mode === "closest-without-going-over") {
    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], sr.guessedPriceCents, score, now, JSON.stringify({ wentOver: sr.wentOver }));

    result = {
      product: getProductsWithPriceForRound(roundProductIds, productMap)[0],
      guessedPriceCents: sr.guessedPriceCents,
      score,
      pctOff: sr.pctOff,
      wentOver: sr.wentOver,
    };
  } else if (sr.mode === "price-match") {
    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], null, score, now, JSON.stringify({ assignments: sr.assignments }));

    result = {
      products: getProductsWithPriceForRound(roundProductIds, productMap),
      assignments: sr.assignments,
      correctCount: sr.correctCount,
      score,
    };
  } else if (sr.mode === "riser") {
    const rd = roundData?.[String(session.current_round)];
    const product = getProductsWithPriceForRound(roundProductIds, productMap)[0];
    const maxPriceCents = rd?.maxPriceCents || product?.priceCents || 0;

    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], sr.stoppedPriceCents, score, now, JSON.stringify({ stoppedPriceCents: sr.stoppedPriceCents, maxPriceCents, wentOver: sr.wentOver }));

    result = {
      product,
      stoppedPriceCents: sr.stoppedPriceCents,
      maxPriceCents,
      score,
      pctOff: sr.pctOff,
      wentOver: sr.wentOver,
    };
  } else if (sr.mode === "odd-one-out") {
    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], null, score, now, JSON.stringify({ guessedProductId: sr.guessedProductId }));

    result = {
      products: getProductsWithPriceForRound(roundProductIds, productMap),
      outlierProductId: sr.outlierProductId,
      guessedProductId: sr.guessedProductId,
      correct: sr.correct,
      score,
    };
  } else if (sr.mode === "market-basket") {
    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], null, score, now, JSON.stringify({ guessedTotalCents: sr.guessedTotalCents }));

    result = {
      products: getProductsWithPriceForRound(roundProductIds, productMap),
      guessedTotalCents: sr.guessedTotalCents,
      actualTotalCents: sr.actualTotalCents,
      pctOff: sr.pctOff,
      score,
    };
  } else if (sr.mode === "sort-it-out") {
    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], null, score, now, JSON.stringify({ submittedOrder: sr.submittedOrder }));

    result = {
      products: getProductsWithPriceForRound(roundProductIds, productMap),
      submittedOrder: sr.submittedOrder,
      correctOrder: sr.correctOrder,
      correctCount: sr.correctCount,
      score,
    };
  } else if (sr.mode === "budget-builder") {
    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], null, score, now, JSON.stringify({ selectedProductIds: sr.selectedProductIds }));

    result = {
      products: getProductsWithPriceForRound(roundProductIds, productMap),
      selectedProductIds: sr.selectedProductIds,
      cartTotalCents: sr.cartTotalCents,
      budgetCents: sr.budgetCents,
      score,
    };
  } else if (sr.mode === "chain-reaction") {
    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], null, score, now, JSON.stringify({ chainGuesses: sr.chainGuesses }));

    result = {
      products: getProductsWithPriceForRound(roundProductIds, productMap),
      chainGuesses: sr.chainGuesses,
      correctCount: sr.correctCount,
      chainLength: sr.chainLength,
      score,
    };
  } else if (sr.mode === "bidding") {
    // Single-player bidding (used by the daily challenge). Score shape mirrors
    // closest-without-going-over so the frontend can render it using the same
    // "one product, one price input" UI.
    const product = getProductsWithPriceForRound(roundProductIds, productMap)[0];
    const wentOver = product ? sr.bidCents > product.priceCents : false;
    const pctOff = product && product.priceCents > 0
      ? Math.abs(product.priceCents - sr.bidCents) / product.priceCents
      : 0;

    db.prepare(
      `INSERT INTO game_rounds (session_id, round_number, product_id, guessed_price_cents, score, guessed_at, guess_data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, session.current_round, roundProductIds[0], sr.bidCents, score, now, JSON.stringify({ bidCents: sr.bidCents, wentOver }));

    result = {
      product,
      guessedPriceCents: sr.bidCents,
      score,
      pctOff,
      wentOver,
    };
  }

  // Force 0 score for timed-out rounds (no selection made)
  // S6 fix: enforce server-side time limit to prevent client-side bypass.
  // H1 fix: if getSessionProduct was never called, treat as timed out to
  // prevent blind-guessing without fetching the product.
  const fetchEntry = roundFetchTimes.get(sessionId);
  let serverTimedOut = false;
  if (!fetchEntry || fetchEntry.round !== session.current_round) {
    // No fetch recorded for this round — player never loaded the product
    serverTimedOut = true;
  } else {
    // Use mode-specific timer limits. New modes reuse MP timer constants since
    // SP timers match (market-basket=45s, budget-builder=60s). Chain reaction uses
    // the MP total (84s) because SP sub-guesses aggregate into one server submission.
    let timerLimitSec: number;
    if (mode === "price-match") {
      timerLimitSec = MP_PRICE_MATCH_TIME_SECONDS;
    } else if (mode === "market-basket") {
      timerLimitSec = MP_MARKET_BASKET_TIME_SECONDS;
    } else if (mode === "budget-builder") {
      timerLimitSec = MP_BUDGET_BUILDER_TIME_SECONDS;
    } else if (mode === "chain-reaction") {
      timerLimitSec = MP_CHAIN_REACTION_TIME_SECONDS;
    } else if (mode === "riser") {
      const rd = roundData?.[String(session.current_round)];
      timerLimitSec = Math.ceil((rd?.durationMs || 8000) / 1000) + 3;
    } else {
      timerLimitSec = ROUND_TIME_SECONDS;
    }
    timerLimitSec *= SP_TIMER_GRACE_FACTOR;
    serverTimedOut = (Date.now() - fetchEntry.fetchedAt) > timerLimitSec * 1000;
  }

  if (guessData?.timedOut || serverTimedOut) {
    score = 0;
    if (result) {
      result.score = 0;
      if ('correct' in result) result.correct = false;
      result.timedOut = true;
    }
  }

  const newTotalScore = session.total_score + score;
  const isDaily = session.is_daily === 1;
  const sessionTotalRounds = getSessionTotalRounds(session);
  const isLastRound = session.current_round >= sessionTotalRounds;

  if (isLastRound) {
    db.prepare(
      `UPDATE game_sessions SET total_score = ?, completed_at = ? WHERE id = ?`
    ).run(newTotalScore, now, sessionId);
    cleanupSessionHints(sessionId);
    cleanupSessionTimers(sessionId);
  } else {
    db.prepare(
      `UPDATE game_sessions SET current_round = current_round + 1, total_score = ? WHERE id = ?`
    ).run(newTotalScore, sessionId);
  }

  // Daily completion: aggregate per-round scores from game_rounds, finalize
  // the daily_plays row, and (for logged-in users) advance the streak. The
  // daily payload is folded into the response so the client can render the
  // streak +1 animation without a follow-up request.
  let dailyPayload: DailyCompletionPayload | undefined;
  if (isDaily && isLastRound) {
    const roundRows = db
      .prepare(
        "SELECT round_number, score FROM game_rounds WHERE session_id = ? ORDER BY round_number ASC"
      )
      .all(sessionId) as { round_number: number; score: number }[];
    const perRoundScores: number[] = [];
    for (let r = 1; r <= DAILY_TOTAL_ROUNDS; r++) {
      const row = roundRows.find((x) => x.round_number === r);
      perRoundScores.push(row?.score ?? 0);
    }

    let streakAtCompletion: number | null = null;
    if (session.user_id) {
      const streakResult = updateStreakOnCompletion(db, session.user_id, session.daily_date!);
      streakAtCompletion = streakResult.current;
      dailyPayload = {
        // Evaluate decay against the challenge date the user just completed
        // (not real wall-clock time). This both matches the mental model of
        // "streak as of this play" and lets tests run on any date without
        // hitting the decay window.
        streak: getStreakForUser(db, session.user_id, session.daily_date ?? undefined),
        isNewBest: streakResult.isNewBest,
        isNewStreak: streakResult.isNewStreak,
      };

      // Cancel any pending streak reminder (user played before it fired)
      // and schedule the next one for streakReminderHours from now
      cancelScheduledNotifications(db, session.user_id, "streak_reminder");
      if (streakResult.current > 0) {
        const reminderAt = new Date(
          Date.now() + config.notifStreakReminderHours * 60 * 60 * 1000,
        ).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
        scheduleNotification(db, session.user_id, "streak_reminder", {
          title: "Your streak is on the line!",
          body: `You have a ${streakResult.current}-day streak. Play today's puzzle to keep it alive!`,
          icon: "/logo192.png",
          image: "/notif/notif-streak.png",
          url: "/daily",
          tag: `streak-${session.user_id}`,
        }, reminderAt);
      }
    }

    db.prepare(
      `UPDATE daily_plays
         SET score = ?,
             per_round_scores = ?,
             streak_at_completion = ?,
             completed_at = ?
       WHERE session_id = ?`
    ).run(
      newTotalScore,
      JSON.stringify(perRoundScores),
      streakAtCompletion,
      now,
      sessionId,
    );
  }

  const updatedSession: GameSession = {
    id: sessionId,
    currentRound: isLastRound ? session.current_round : session.current_round + 1,
    totalRounds: sessionTotalRounds,
    totalScore: newTotalScore,
    completed: isLastRound,
    gameMode: mode,
  };

  const response: {
    result: any;
    session: GameSession;
    daily?: DailyCompletionPayload;
    nextRoundImageUrls?: string[];
  } = {
    result,
    session: updatedSession,
  };
  if (dailyPayload) response.daily = dailyPayload;

  // Preload hint: when there's another round coming, expose the URLs the
  // client will need next so the image cache can warm during the reveal.
  // Products for the whole session are pre-selected at /start, so looking
  // up the next round's IDs is just a slice of `selected_products` — no
  // commit semantics, no N+1 query, safe to surface to the client.
  if (!isLastRound) {
    try {
      const nextRoundNumber = session.current_round + 1;
      const nextIds = getRoundProductIds(
        mode,
        selectedIds,
        nextRoundNumber,
        roundData,
      );
      if (nextIds.length > 0) {
        response.nextRoundImageUrls = nextIds.map((id) => `/api/image/${id}`);
      }
    } catch (hintErr) {
      // Never let a preload hint failure break the main response. Logged
      // so an unexpected regression in `getRoundProductIds` surfaces
      // instead of silently dropping the optimization.
      console.warn(`nextRoundImageUrls hint failed for session ${sessionId}:`, hintErr);
    }
  }

  return response;
}
