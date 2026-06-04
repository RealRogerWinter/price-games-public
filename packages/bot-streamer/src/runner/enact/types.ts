/**
 * Enactor — translates a chosen strategy candidate into UI actions on
 * the page. One per game mode; the registry maps `GameMode` → Enactor.
 *
 * Enactors operate on the abstract `PageLike` surface so they're
 * unit-testable with a fake page. The realism layer wraps individual
 * actions (mouse jitter, typing rhythm) elsewhere — enactors stay
 * declarative.
 */

import type { GameMode, GuessData } from "@price-game/shared";
import type { PageLike } from "../pageLike";

export interface EnactorContext {
  /** Inject for deterministic tests. Default Math.random. */
  rng?: () => number;
  /** Clock for deterministic delays in tests. Default Date.now. */
  now?: () => number;
  /**
   * Inject a sleep for deterministic tests / fast-forwarding fake
   * timers. Defaults to wall-clock setTimeout when unset. Used by
   * the B6 inter-action delay path so per-mode tests don't pay the
   * 600–1500ms-per-step real-time cost.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface Enactor {
  readonly mode: GameMode;
  /**
   * Translate `payload` into UI actions on `page`. Resolves once the
   * answer has been submitted to the server (e.g. the submit button
   * has been clicked).
   *
   * @throws If a required selector isn't present (e.g. the round_start
   *         landed before the page rendered the controls). Callers
   *         should treat throws as "skip this round" rather than
   *         crash the lifecycle.
   */
  enact(payload: GuessData, page: PageLike, ctx?: EnactorContext): Promise<void>;
}
