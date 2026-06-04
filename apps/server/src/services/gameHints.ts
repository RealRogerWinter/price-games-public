/**
 * Hint system for single-player games.
 *
 * Provides a price range hint once per round for classic and
 * closest-without-going-over modes.
 */
import db from "../db";
import type { GameMode } from "@price-game/shared";
import type { DbSession } from "./gameSession";

// Track which rounds have used hints: sessionId -> { rounds, createdAt }
// Entries are evicted when a session completes via cleanupSessionHints(),
// or by periodic cleanup for abandoned sessions.
const usedHints = new Map<string, { rounds: Set<number>; createdAt: number }>();

/** Remove hint tracking for a completed session. */
export function cleanupSessionHints(sessionId: string): void {
  usedHints.delete(sessionId);
}

// S7 fix: periodically evict hint entries for abandoned sessions (>1 hour old)
const HINT_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of usedHints) {
    if (now - entry.createdAt > HINT_TTL_MS) {
      usedHints.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

export function getHint(
  sessionId: string
): { hintRange: { min: number; max: number } } | null {
  const session = db
    .prepare("SELECT * FROM game_sessions WHERE id = ?")
    .get(sessionId) as DbSession | undefined;

  if (!session || session.completed_at) return null;

  const mode = (session.game_mode || "classic") as GameMode;
  // Hints only for classic and closest modes
  if (mode !== "classic" && mode !== "closest-without-going-over") return null;

  if (!usedHints.has(sessionId)) usedHints.set(sessionId, { rounds: new Set(), createdAt: Date.now() });
  const sessionHints = usedHints.get(sessionId)!;
  if (sessionHints.rounds.has(session.current_round)) return null;

  sessionHints.rounds.add(session.current_round);

  const selectedIds: number[] = JSON.parse(session.selected_products);
  const currentProductId = selectedIds[session.current_round - 1];
  if (currentProductId === undefined) return null;

  const product = db
    .prepare("SELECT price_cents FROM products WHERE id = ?")
    .get(currentProductId) as { price_cents: number } | undefined;

  if (!product) return null;

  const priceCents = product.price_cents;
  const lowerPct = 0.10 + Math.random() * 0.15;
  const upperPct = 0.10 + Math.random() * 0.15;
  const min = Math.max(1, Math.round(priceCents * (1 - lowerPct)));
  const max = Math.round(priceCents * (1 + upperPct));

  return { hintRange: { min, max } };
}
