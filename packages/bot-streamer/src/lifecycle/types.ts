/**
 * Lifecycle plan — what the bot intends to do next.
 *
 * The lifecycle controller doesn't know how to execute these directly;
 * a `Driver` injected at runtime handles the actual REST/socket calls.
 * Decoupling them makes the policy unit-testable without spinning up
 * HTTP/socket fixtures.
 */

import type { BotDifficulty, GameMode } from "@price-game/shared";

export interface SoloPlan {
  kind: "solo";
  /** Game mode to request. Bidding is multiplayer-only and never appears here. */
  mode: GameMode;
  /** Number of rounds to request from `/api/game/start`. */
  rounds: number;
}

export interface PublicJoinPlan {
  kind: "public_join";
  /** When true, the runner must fall back to host_public if no lobby is found. */
  fallbackToHost: boolean;
}

export interface HostPublicPlan {
  kind: "host_public";
  mode: GameMode;
  rounds: number;
  /** Maximum seconds to wait for opponents before starting anyway. */
  waitForOpponentsSeconds: number;
}

/**
 * Phase 3d.2: spin up a Quick Play bidding-war lobby filled with
 * server-side NPC opponents (autoStart) and play the rounds. The
 * streamer-bot is the only "human" player; the other 3 seats are
 * filled by `botPersonality.ts` archetypes whose distribution we
 * exploit in the bidding decoder. Driver implementation calls
 * `/api/mp/quickplay` and either joins (`action: "join"`) or
 * creates with `autoStart` (`action: "create"`).
 */
export interface QuickplayBiddingPlan {
  kind: "quickplay_bidding";
  /** Total bidding rounds in the game. Default 5 matches Quick Play UX. */
  rounds: number;
  /** Difficulty bucket to request for the auto-filled NPCs. */
  botDifficulty: BotDifficulty;
}

export type LifecyclePlan = SoloPlan | PublicJoinPlan | HostPublicPlan | QuickplayBiddingPlan;

/**
 * Outcome of executing a plan, used by the policy to update its rotation
 * cursor and any future "skip-on-failure" tracking.
 */
export interface PlanOutcome {
  plan: LifecyclePlan;
  status: "completed" | "no_match" | "error";
  /** ms duration the plan ran for. Used for soft rate-limiting. */
  durationMs?: number;
  /** Optional human-readable error reason, attached when status === "error". */
  error?: string;
}
