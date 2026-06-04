/**
 * Multiplayer round end — results computation, reveal data, and leaderboard saving.
 */
import type { Server } from "socket.io";
import db from "../db";
import { toProductWithPrice, getProductsByIds, getProductsWithPriceForRound } from "./productMapper";
import { getActivePlayers } from "./mpRoundStart";
import { clearRoundTimer, hasRoundEnded, setRoundEnded } from "./mpTimerState";
import { sanitizeName } from "./inputSanitizer";
import { recordMultiplayerGame } from "./userGameHistory";
import { recordVisitorGamePlay } from "./visitorAttribution";
import { applyVisitorWinUpdateEnsureRow } from "./winRecordWriter";
import { updateStreakOnCompletion } from "./dailyStreak";
import { recordRoundCompleted, applyBuffs, grantPublicGameBuff } from "./inviteRewards";
import { recordEvent } from "./eventLog";
import { getPlayerSocketId } from "../socket/socketState";
import { creditGhostScore } from "./ghostUsers/credit";
import type { DbPlayer } from "./dbTypes";
import {
  GameMode,
  Avatar,
  DEFAULT_AVATAR,
  RoundResultsPayload,
  PlayerRoundResult,
  RevealData,
  identifyOutlier,
  ANALYTICS_EVENTS,
  computeIsWin,
  type IsWin,
} from "@price-game/shared";
import type { DbRoom } from "./dbTypes";

export function endRound(roomCode: string, io?: Server): RoundResultsPayload | null {
  // Prevent double-ending: check in-memory flag first (fast path)
  if (hasRoundEnded(roomCode)) return null;
  setRoundEnded(roomCode, true);
  clearRoundTimer(roomCode);

  // C3 fix: DB-level idempotency — claim the round-end atomically
  const claimed = db
    .prepare("UPDATE mp_rooms SET status = 'ending' WHERE code = ? AND status = 'playing'")
    .run(roomCode);
  if (claimed.changes === 0) return null;

  const result = db.transaction(() => {
    const room = db.prepare("SELECT * FROM mp_rooms WHERE code = ?").get(roomCode) as DbRoom | undefined;
    if (!room) return null;

    const mode = room.game_mode as GameMode;
    const roundData = room.round_data ? JSON.parse(room.round_data) : {};
    const roundMeta = roundData[String(room.current_round)] || {};
    const productIds: number[] = JSON.parse(room.selected_products || "[]");
    const activePlayers = getActivePlayers(roomCode);
    const now = new Date().toISOString();

    // Insert score=0 for players who didn't guess
    for (const player of activePlayers) {
      const existing = db
        .prepare("SELECT id FROM mp_guesses WHERE room_code = ? AND player_id = ? AND round_number = ?")
        .get(roomCode, player.id, room.current_round);
      if (!existing) {
        db.prepare(
          `INSERT INTO mp_guesses (room_code, player_id, round_number, guess_data, score, submitted_at)
           VALUES (?, ?, ?, ?, 0, ?)`
        ).run(roomCode, player.id, room.current_round, JSON.stringify({ timedOut: true }), now);
      }
    }

    // Build reveal data (the actual answer)
    const revealData = buildRevealData(mode, productIds, roundMeta);

    // Collect player results for this round
    const guesses = db
      .prepare("SELECT * FROM mp_guesses WHERE room_code = ? AND round_number = ?")
      .all(roomCode, room.current_round) as any[];

    const playerResults: PlayerRoundResult[] = guesses.map((g) => {
      const player = activePlayers.find((p) => p.id === g.player_id);
      return {
        playerId: g.player_id,
        displayName: player?.display_name || "Unknown",
        avatar: (player?.avatar || DEFAULT_AVATAR) as Avatar,
        score: g.score,
        guessData: g.guess_data ? JSON.parse(g.guess_data) : null,
      };
    }).sort((a, b) => b.score - a.score);

    // Get updated standings
    const updatedPlayers = getActivePlayers(roomCode);
    const standings = updatedPlayers
      .map((p) => ({
        playerId: p.id,
        displayName: p.display_name,
        avatar: p.avatar as Avatar,
        totalScore: p.total_score,
      }))
      .sort((a, b) => b.totalScore - a.totalScore);

    // Lobby-invite reward — increment rounds_completed for any pending
    // attribution in this room. The round counter only ticks for joiners
    // who actually submitted a guess this round (excluding the timeout
    // fallback inserted above).
    const realGuesserIds = (db
      .prepare(
        `SELECT player_id FROM mp_guesses
          WHERE room_code = ? AND round_number = ?
            AND (guess_data IS NULL OR guess_data NOT LIKE '%"timedOut":true%')`,
      )
      .all(roomCode, room.current_round) as Array<{ player_id: string }>)
      .map((r) => r.player_id);

    type InviteEarn = {
      hostSocketIds: string[];
      joinerSocketId: string | null;
      hostEvent: NonNullable<ReturnType<typeof recordRoundCompleted>["hostEvent"]>;
      joinerEvent: NonNullable<ReturnType<typeof recordRoundCompleted>["joinerEvent"]>;
      joinerDisplayName: string;
    };
    const inviteEarns: InviteEarn[] = [];
    for (const playerId of realGuesserIds) {
      try {
        const out = recordRoundCompleted(db, { roomCode, joinerPlayerId: playerId });
        if (out.earned && out.hostEvent && out.joinerEvent) {
          // Find the joiner's display name + socket; find host sockets by visitor/user id.
          const joinerRow = db
            .prepare("SELECT display_name FROM mp_players WHERE id = ?")
            .get(playerId) as { display_name: string } | undefined;
          inviteEarns.push({
            hostEvent: { ...out.hostEvent, joinerDisplayName: joinerRow?.display_name ?? "" },
            joinerEvent: out.joinerEvent,
            joinerSocketId: getPlayerSocketId(playerId) ?? null,
            hostSocketIds: findSocketIdsForBeneficiary(
              out.hostEvent.inviterUserId,
              out.hostEvent.inviterVisitorId,
              roomCode,
            ),
            joinerDisplayName: joinerRow?.display_name ?? "",
          });
        }
      } catch (err) {
        console.error("[invite] recordRoundCompleted failed", err);
      }
    }

    // Check if game is over
    const isLastRound = room.current_round >= room.total_rounds;

    if (isLastRound) {
      db.prepare("UPDATE mp_rooms SET status = 'finished', finished_at = ?, last_activity_at = ? WHERE code = ?").run(now, now, roomCode);
      // Pass `current_game_id` to the completion path so its dedup keys can
      // disambiguate between distinct games in the same room (Play Again).
      // Falls back to the room's `created_at` for legacy rows that pre-date
      // the v59 migration — still deterministic, still room-stable.
      const gameId = room.current_game_id ?? `legacy:${room.created_at}`;
      saveToLeaderboard(roomCode, mode, gameId, standings, room.total_rounds, io);
      if (room.is_daily_game === 1 && room.daily_date) {
        recordDailyPlaysForRoom(roomCode, gameId, room.daily_date, mode, room.total_rounds, now);
      }
      // Public-lobby completion buff. Granted to every real human (not
      // bots, not ghosts) who saw the final round's results in a public
      // room. Applies to their NEXT match, so this player can't double-
      // count it against the round they just played. The grant fn is
      // idempotent against existing active public_game buffs.
      if (room.is_public === 1) {
        try {
          const humans = db
            .prepare(
              "SELECT user_id, visitor_id FROM mp_players WHERE room_code = ? AND is_kicked = 0 AND is_bot = 0 AND is_streamer_bot = 0",
            )
            .all(roomCode) as Array<{ user_id: string | null; visitor_id: string | null }>;
          for (const h of humans) {
            if (!h.user_id && !h.visitor_id) continue;
            grantPublicGameBuff(db, {
              beneficiaryUserId: h.user_id,
              beneficiaryVisitorId: h.visitor_id ?? "",
            });
          }
        } catch (err) {
          // Non-fatal: buff is a perk, not gameplay-critical.
          console.error("[public_game] grantPublicGameBuff batch failed", err);
        }
      }
    } else {
      db.prepare("UPDATE mp_rooms SET status = 'between_rounds', last_activity_at = ? WHERE code = ?").run(now, roomCode);
    }

    // Side effect: emit invite reward events outside the txn — but we have to
    // close over `io` from the outer scope and emit AFTER the txn commits.
    // We capture into the outer-scope returnable below and emit at the
    // bottom of endRound.
    return {
      payload: {
        roundNumber: room.current_round,
        gameMode: mode,
        revealData,
        playerResults,
        standings,
      } as RoundResultsPayload,
      inviteEarns,
    };
  })();

  if (!result) return null;

  // Emit invite reward events post-commit. Silent no-op if no io was passed.
  if (io) {
    for (const earn of result.inviteEarns) {
      for (const sid of earn.hostSocketIds) {
        io.to(sid).emit("invite:reward_earned", earn.hostEvent);
      }
      if (earn.joinerSocketId) {
        io.to(earn.joinerSocketId).emit("invite:welcome_bonus", earn.joinerEvent);
      }
    }
  }

  return result.payload;
}

/**
 * Find live socket ids for the beneficiary of an invite reward, scoped to
 * this room. Used to direct-emit `invite:reward_earned` to the host's
 * socket(s) without broadcasting to the room.
 */
function findSocketIdsForBeneficiary(
  userId: string | null,
  visitorId: string,
  roomCode: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM mp_players
        WHERE room_code = ?
          AND is_kicked = 0
          AND ((? IS NOT NULL AND user_id = ?) OR (? IS NOT NULL AND visitor_id = ?))`,
    )
    .all(roomCode, userId, userId, visitorId, visitorId) as Array<{ id: string }>;
  const ids: string[] = [];
  for (const row of rows) {
    const sid = getPlayerSocketId(row.id);
    if (sid) ids.push(sid);
  }
  return ids;
}

function buildRevealData(mode: GameMode, productIds: number[], roundMeta: Record<string, any>): RevealData {
  if (mode === "comparison") {
    const products = getProductsWithPriceForRound(productIds);
    const productsForScoring = products.map((p) => ({ id: p.id, priceCents: p.priceCents }));
    const sorted = [...productsForScoring].sort((a, b) => a.priceCents - b.priceCents);
    const correctProductId = roundMeta.question === "most-expensive"
      ? sorted[sorted.length - 1].id
      : sorted[0].id;
    return { mode: "comparison", products, question: roundMeta.question, correctProductId };
  }

  if (mode === "price-match") {
    const products = getProductsWithPriceForRound(productIds);
    return { mode: "price-match", products };
  }

  if (mode === "odd-one-out") {
    const products = getProductsWithPriceForRound(productIds);
    const productsForScoring = products.map((p) => ({ id: p.id, priceCents: p.priceCents }));
    const outlierProductId = identifyOutlier(productsForScoring);
    return { mode: "odd-one-out", products, outlierProductId };
  }

  if (mode === "market-basket") {
    const products = getProductsWithPriceForRound(productIds);
    const actualTotalCents = products.reduce((s, p) => s + p.priceCents, 0);
    return { mode: "market-basket", products, actualTotalCents };
  }

  if (mode === "sort-it-out") {
    const products = getProductsWithPriceForRound(productIds);
    const correctOrder = [...products].sort((a, b) => a.priceCents - b.priceCents).map((p) => p.id);
    return { mode: "sort-it-out", products, correctOrder };
  }

  if (mode === "budget-builder") {
    const products = getProductsWithPriceForRound(productIds);
    return { mode: "budget-builder", products, budgetCents: roundMeta.budgetCents || 0 };
  }

  if (mode === "chain-reaction") {
    const products = getProductsWithPriceForRound(productIds);
    return { mode: "chain-reaction", products };
  }

  if (mode === "bidding") {
    const products = getProductsWithPriceForRound([productIds[0]]);
    const product = products[0] ?? { id: 0, title: "Unknown", imageUrl: "", description: "", category: "", priceCents: 0 };
    const bids = roundMeta.bids ?? [];
    return { mode: "bidding", product, bids };
  }

  // Single product modes
  const singleProducts = getProductsWithPriceForRound([productIds[0]]);
  if (singleProducts.length === 0) {
    // Fallback: return a classic reveal with a placeholder — should never happen
    // because products were selected from DB, but guards against data corruption.
    return { mode: "classic", product: { id: 0, title: "Unknown", imageUrl: "", description: "", category: "", priceCents: 0 } };
  }
  const product = singleProducts[0];

  if (mode === "higher-lower") {
    return { mode: "higher-lower", product, referencePrice: roundMeta.referencePrice };
  }

  if (mode === "riser") {
    return { mode: "riser", product, maxPriceCents: roundMeta.maxPriceCents };
  }

  if (mode === "closest-without-going-over") {
    return { mode: "closest-without-going-over", product };
  }

  // classic
  return { mode: "classic", product };
}

function saveToLeaderboard(
  roomCode: string,
  mode: GameMode,
  /**
   * Per-game UUID stamped on the lobby→playing transition (see
   * `mpRoundStart.ts`). Used as the scope for the deterministic
   * `client_event_id` on every `mp_game_completed` emit so a duplicate
   * `endRound` call dedups via `UNIQUE(visitor_id, client_event_id)`
   * even though no client beacon was involved.
   */
  gameId: string,
  standings: { playerId: string; displayName: string; totalScore: number }[],
  totalRounds: number,
  io?: Server,
): void {
  const now = new Date().toISOString();
  const insertRealHuman = db.prepare(
    `INSERT INTO mp_leaderboard (player_name, room_code, score, placement, players_count, game_mode, played_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertGhost = db.prepare(
    `INSERT INTO mp_leaderboard (player_name, room_code, score, placement, players_count, game_mode, played_at, user_id, ghost_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  );

  // Bucket each standing into one of four groups by their mp_players row:
  //   - real human (is_bot=0): existing behavior; appears on the leaderboard
  //   - ghost (is_bot=1 AND ghost_user_id IS NOT NULL): writes a leaderboard
  //     row tied to the ghost identity, plus credits the ghost's score with
  //     the percentile-cap soft-limit applied
  //   - bot_wl_only (is_streamer_bot=1): skipped from the leaderboard /
  //     user_game_history / MP_GAME_COMPLETED, but the bot's visitor
  //     `lifetime_wins`/`losses`/`current_streak` row is bumped so the in-
  //     game W/L HUD chip the bot reads in its own browser shows real
  //     numbers. Excluded from `credited`/`totalPlayers` so the bot does
  //     not inflate human-side analytics or trip the solo-room anti-farm
  //     guard for the human (a 1-human + 1-bot lobby still resolves to
  //     `is_win = NULL` for the human, same as today).
  //   - labeled bot (is_bot=1 AND ghost_user_id IS NULL): skipped entirely
  type Bucket =
    | { kind: "human"; userId: string | null; visitorId: string | null }
    | { kind: "ghost"; ghostUserId: string }
    | { kind: "bot_wl_only"; visitorId: string | null }
    | { kind: "skip" };
  const buckets = standings.map<Bucket>((s) => {
    const row = db
      .prepare(
        "SELECT is_bot, ghost_user_id, user_id, visitor_id, is_streamer_bot FROM mp_players WHERE id = ?",
      )
      .get(s.playerId) as
      | {
          is_bot: number;
          ghost_user_id: string | null;
          user_id: string | null;
          visitor_id: string | null;
          is_streamer_bot: number;
        }
      | undefined;
    if (row?.is_streamer_bot === 1) {
      return { kind: "bot_wl_only", visitorId: row.visitor_id ?? null };
    }
    if (!row || row.is_bot === 0) {
      return { kind: "human", userId: row?.user_id ?? null, visitorId: row?.visitor_id ?? null };
    }
    if (row.ghost_user_id) {
      return { kind: "ghost", ghostUserId: row.ghost_user_id };
    }
    return { kind: "skip" };
  });

  type BuffEmit = {
    socketId: string;
    payload: {
      source: string;
      multiplier: number;
      matchesRemaining: number;
      rawScore: number;
      finalScore: number;
      roomCode: string;
    };
  };
  const buffEmits: BuffEmit[] = [];

  // Collected during the txn, emitted post-commit. One per REAL human player
  // (bot- and ghost-filtered upstream — buckets[i].kind === "human"). Ghosts
  // do NOT emit because v2 analytics counts only real players.
  type CompletionEmit = {
    visitorId: string;
    userId: string | null;
    finalScore: number;
    rawScore: number;
    placement: number;
    wasBuffed: boolean;
  };
  const completionEmits: CompletionEmit[] = [];

  // Placement (1-indexed) is calculated against humans + ghosts only, so
  // the leaderboard placement matches what the player saw on the results
  // screen. `bot_wl_only` and `skip` are excluded so the streamer-bot
  // does not inflate human-side `players_count` or shift placements.
  const credited = standings
    .map((s, i) => ({ s, b: buckets[i] }))
    .filter((x) => x.b.kind === "human" || x.b.kind === "ghost");
  const totalPlayers = credited.length;

  // Streamer-bot W/L tracking. The W/L update itself runs inside the
  // same `saveAll` transaction below (alongside the human/ghost
  // inserts) so a rollback unwinds it too. Bot placement is computed
  // against humans + ghosts + the bot itself (excluding labeled auto-
  // lobby bots), so a 1-human-vs-1-streamer-bot game produces a real
  // W/L for the bot while the human's outcome still trips the existing
  // solo-room anti-farm rule (humans see `playersCount = credited.length = 1`).
  // Tie-at-top semantics: when the bot's totalScore equals the top
  // human's, JS's stable Array.sort puts whichever entered standings
  // first at index 0. We promote the bot to placement 1 explicitly
  // when it shares the top score, mirroring `recordMultiplayerGame`'s
  // "ties at placement 1 count as a win" rule.
  const botRanking = standings
    .map((s, i) => ({ s, b: buckets[i] }))
    .filter(
      (x) => x.b.kind === "human" || x.b.kind === "ghost" || x.b.kind === "bot_wl_only",
    );
  const topScore = botRanking.length > 0 ? botRanking[0].s.totalScore : -Infinity;
  const botEntries: { totalScore: number; placement: number; visitorId: string }[] = [];
  for (let r = 0; r < botRanking.length; r++) {
    const { s, b } = botRanking[r];
    if (b.kind !== "bot_wl_only") continue;
    if (!b.visitorId) continue;
    // Tie-at-top: any bot tied with the highest score in the room is
    // treated as placement 1 so the existing "ties at placement 1 count
    // as wins" rule (see `multiplayerWins` semantics) extends to the bot.
    const placement = s.totalScore === topScore ? 1 : r + 1;
    botEntries.push({
      totalScore: s.totalScore,
      placement,
      visitorId: b.visitorId,
    });
  }
  // Player count the bot's classifier sees: humans + ghosts + 1 (the bot).
  // When this is < 2, the helper returns null (anti-farm).
  const botPlayersCount = totalPlayers + (botEntries.length > 0 ? 1 : 0);

  const saveAll = db.transaction(() => {
    for (let i = 0; i < credited.length; i++) {
      const { s, b } = credited[i];
      const placement = i + 1;
      let safeName: string;
      try {
        safeName = sanitizeName(s.displayName);
      } catch {
        safeName = "Player";
      }

      if (b.kind === "human") {
        // Apply lobby-invite buff (if any). Buffs are keyed on user_id when
        // present; visitor-keyed buffs are still honored if the player is a
        // guest. No-op when there's no active buff. Gating on EITHER identity
        // — `visitorId` alone skipped user-keyed buffs for legacy mp_players
        // rows where visitor_id is NULL (added in v37). The service handles
        // either key fine — pass an empty-string visitor sentinel so it
        // falls back to user_id only.
        const rawScore = s.totalScore;
        let finalScore = rawScore;
        let buffApplied: { source: string; multiplier: number; matchesRemaining: number } | null = null;
        if (b.userId || b.visitorId) {
          try {
            const result = applyBuffs(db, {
              rawScore,
              beneficiaryUserId: b.userId,
              beneficiaryVisitorId: b.visitorId ?? "",
            });
            finalScore = result.finalScore;
            if (result.applied) {
              buffApplied = {
                source: result.applied.source,
                multiplier: result.applied.multiplier,
                matchesRemaining: result.applied.matchesRemaining,
              };
            }
          } catch (err) {
            console.error("[invite] applyBuffs failed", err);
          }
        }

        insertRealHuman.run(safeName, roomCode, finalScore, placement, totalPlayers, mode, now, b.userId);

        if (buffApplied) {
          const socketId = getPlayerSocketId(s.playerId);
          if (socketId) {
            buffEmits.push({
              socketId,
              payload: {
                source: buffApplied.source,
                multiplier: buffApplied.multiplier,
                matchesRemaining: buffApplied.matchesRemaining,
                rawScore,
                finalScore,
                roomCode,
              },
            });
          }
        }

        let mpOutcome: IsWin = null;
        if (b.userId) {
          try {
            mpOutcome = recordMultiplayerGame(
              db,
              b.userId,
              roomCode,
              mode,
              finalScore,
              placement,
              // Anti-streak-farm: pass the credited (skip-filtered) count,
              // not standings.length. A 1-human + N-auto-bots lobby has
              // credited=1 → counts as a solo room → is_win = NULL.
              totalPlayers,
              totalRounds,
              false, // human seats are filtered above; bot/streamer-bot rows already short-circuited as "skip".
              buffApplied ? { wasBuffed: true, rawScore } : undefined,
            );
          } catch {
            // Non-critical
          }
        } else {
          // Anonymous human seat — derive the outcome via the shared helper
          // so the bot-lobby anti-farm rule applies here too. MP outcome
          // depends only on placement and credited count; totalRounds is
          // unused for MP classification but the helper signature requires it.
          mpOutcome = computeIsWin({
            gameType: "multiplayer",
            gameMode: mode,
            score: finalScore,
            totalRounds,
            placement,
            playersCount: totalPlayers,
            isBotPlayer: false,
          });
        }
        if (b.visitorId) {
          try {
            recordVisitorGamePlay(db, b.visitorId, "multiplayer", mode, mpOutcome);
          } catch {
            // Non-critical
          }
          // Defer the analytics emit until after this transaction commits —
          // recordEvent does its own writes (visitor_profile, analytics_sessions,
          // events) and nesting them inside this txn would either fail
          // (better-sqlite3 forbids nested transactions) or pollute the
          // leaderboard txn's atomicity guarantees.
          completionEmits.push({
            visitorId: b.visitorId,
            userId: b.userId,
            finalScore,
            rawScore,
            placement,
            wasBuffed: !!buffApplied,
          });
        }
      } else if (b.kind === "ghost") {
        // Credit the ghost FIRST so a failure prevents the leaderboard
        // row from landing without a matching lifetime/history update.
        // Without this ordering, a credit throw would leave mp_leaderboard
        // populated but ghost_users.lifetime_score and ghost_game_history
        // out of sync — silent drift accumulates over time.
        let creditOk = true;
        try {
          creditGhostScore(db, b.ghostUserId, {
            addedScore: Math.max(0, s.totalScore),
            gameType: "multiplayer",
            gameMode: mode,
            roomCode,
            placement,
            playersCount: totalPlayers,
          });
        } catch (err) {
          creditOk = false;
          // Log enough context to backfill manually if this ever fires.
          console.error(
            `[mpRoundEnd] ghost credit failed for ghost=${b.ghostUserId} room=${roomCode} mode=${mode} score=${s.totalScore} placement=${placement}`,
            err,
          );
        }
        if (creditOk) {
          insertGhost.run(
            safeName, roomCode, s.totalScore, placement, totalPlayers, mode, now, b.ghostUserId,
          );
        }
      }
    }

    // Streamer-bot W/L: bumps the bot's visitor_attribution row only.
    // Lives inside the leaderboard transaction so a bot W/L update
    // either commits with the rest of the room's results or rolls
    // back with them — no half-applied state. `isBotPlayer: false` is
    // intentional (we DO want to track this bot); the helper's bot
    // guard exists for labeled auto-lobby bots that we don't track.
    for (const be of botEntries) {
      const outcome = computeIsWin({
        gameType: "multiplayer",
        gameMode: mode,
        score: be.totalScore,
        totalRounds,
        placement: be.placement,
        playersCount: botPlayersCount,
        isBotPlayer: false,
      });
      try {
        applyVisitorWinUpdateEnsureRow(db, be.visitorId, outcome);
      } catch (err) {
        // Non-critical decorative state — never block the room results.
        console.error(
          `[mpRoundEnd] streamer-bot W/L update failed visitor=${be.visitorId} room=${roomCode}`,
          err,
        );
      }
    }
  });
  saveAll();

  // Emit post-commit so clients see buff data after persistence.
  if (io) {
    for (const e of buffEmits) {
      io.to(e.socketId).emit("invite:buff_consumed", e.payload);
    }
  }

  // Analytics: one mp_game_completed event per real human player. Real-player
  // filtering already happened upstream via the bucket classifier — only
  // human-bucket entries with a non-null visitor_id reach this list. Ghosts
  // and labeled bots are absent by construction so v2's MP completion count
  // strictly tracks "real player completions".
  for (const c of completionEmits) {
    recordEvent({
      eventName: ANALYTICS_EVENTS.MP_GAME_COMPLETED,
      eventType: "mp",
      visitorId: c.visitorId,
      userId: c.userId,
      gameMode: mode,
      mpRoomCode: roomCode,
      // Dedup key scoped on (gameId, visitorId, eventName). Two callers of
      // endRound() landing past the C3 status='ending' claim is the
      // textbook surface this guards. UNIQUE(visitor_id, client_event_id)
      // absorbs the dup via INSERT OR IGNORE in recordEvent.
      clientEventId: `srv:mp_game_completed:${gameId}:${c.visitorId}`,
      properties: {
        room_code: roomCode,
        game_mode: mode,
        game_id: gameId,
        score: c.finalScore,
        raw_score: c.rawScore,
        placement: c.placement,
        players_count: completionEmits.length,
        was_buffed: c.wasBuffed,
        is_logged_in: !!c.userId,
      },
    });
  }
}

/**
 * Mirror the SP daily-completion write for every human player in a daily MP
 * room. Inserts a `daily_plays` row with the player's total score + per-round
 * scores and, for logged-in users, bumps the streak.
 *
 * Important:
 *   - `session_id` is unique per-player (`<roomCode>:<playerId>`) because the
 *     column has a UNIQUE constraint — using the raw `roomCode` would only
 *     let the first player's insert land and silently drop the rest.
 *   - The insert happens BEFORE the streak update. If the insert hits a
 *     once-per-day UNIQUE violation (the player already completed today's
 *     daily via some other path), we skip the streak bump too — otherwise
 *     the streak would be credited without a matching daily_plays row.
 */
function recordDailyPlaysForRoom(
  roomCode: string,
  /**
   * Per-game UUID — used to scope the dedup key on the `daily_completed`
   * event so the second invocation of `endRound` doesn't double-count a
   * daily completion. The `daily_plays` insert itself is already
   * UNIQUE-protected on (user_id, daily_date) and (visitor_id, daily_date);
   * this keeps the analytics emit in lockstep with the row.
   */
  gameId: string,
  dailyDate: string,
  mode: GameMode,
  totalRounds: number,
  completedAt: string,
): void {
  const players = db
    .prepare(
      "SELECT * FROM mp_players WHERE room_code = ? AND is_kicked = 0 AND is_bot = 0 AND is_streamer_bot = 0",
    )
    .all(roomCode) as DbPlayer[];

  const perPlayerRounds = db.prepare(
    "SELECT round_number, score FROM mp_guesses WHERE room_code = ? AND player_id = ? ORDER BY round_number ASC",
  );

  const insertPlay = db.prepare(
    `INSERT INTO daily_plays
       (user_id, session_id, daily_date, game_mode, score, per_round_scores, started_at, completed_at, streak_at_completion, visitor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const player of players) {
    // Only write for players with at least one identifier — otherwise we
    // can't enforce once-per-day anyway.
    if (!player.user_id && !player.visitor_id) continue;

    const rounds = perPlayerRounds.all(roomCode, player.id) as { round_number: number; score: number }[];
    const perRoundScores: number[] = [];
    for (let r = 1; r <= totalRounds; r++) {
      const match = rounds.find((x) => x.round_number === r);
      perRoundScores.push(match?.score ?? 0);
    }

    // Insert first with `streak_at_completion = NULL`; only if that succeeds
    // do we bump the streak and patch it in. This keeps streaks and rows
    // in lockstep — if the insert collides on a partial unique index
    // (once-per-day across SP + MP paths), the player's streak is not bumped.
    let inserted = true;
    try {
      insertPlay.run(
        player.user_id ?? null,
        `${roomCode}:${player.id}`,
        dailyDate,
        mode,
        player.total_score,
        JSON.stringify(perRoundScores),
        completedAt,
        completedAt,
        null,
        player.visitor_id ?? null,
      );
    } catch (err) {
      inserted = false;
      const code = (err as { code?: string })?.code;
      if (code !== "SQLITE_CONSTRAINT_UNIQUE") {
        // Unexpected failure — log but don't throw (the room is otherwise
        // complete and the socket response is already out).
        console.error("recordDailyPlaysForRoom: insert failed", err);
      }
    }

    if (inserted && player.user_id) {
      try {
        const streakResult = updateStreakOnCompletion(db, player.user_id, dailyDate);
        db.prepare(
          "UPDATE daily_plays SET streak_at_completion = ? WHERE session_id = ?",
        ).run(streakResult.current, `${roomCode}:${player.id}`);
      } catch {
        // Streak bookkeeping is advisory — the play row already exists, so
        // swallowing keeps the rest of the room's completion path running.
      }
    }

    // Daily-completed analytics emit (only when the daily_plays insert
    // landed). Skipping unique-violation cases keeps v2 in lockstep with the
    // table — if the player didn't actually complete today's daily through
    // this path, we don't fabricate an event.
    if (inserted && player.visitor_id) {
      recordEvent({
        eventName: ANALYTICS_EVENTS.DAILY_COMPLETED,
        eventType: "game",
        visitorId: player.visitor_id,
        userId: player.user_id ?? null,
        gameMode: mode,
        mpRoomCode: roomCode,
        // Dedup key scoped on (gameId, visitorId, eventName).
        clientEventId: `srv:daily_completed:${gameId}:${player.visitor_id}`,
        properties: {
          daily_date: dailyDate,
          game_mode: mode,
          score: player.total_score,
          via: "multiplayer",
          is_logged_in: !!player.user_id,
        },
      });
    }
  }
}
