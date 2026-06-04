/** Unique identifier for every sound effect in the game. */
export type SoundId =
  // Core gameplay
  | "timer_tick"
  | "timer_urgent"
  | "timer_critical"
  | "timer_expire"
  | "guess_submit"
  | "round_start"
  | "result_exact"
  | "result_great"
  | "result_good"
  | "result_poor"
  | "result_miss"
  | "confetti"
  | "score_counting"
  | "next_round"
  | "game_over"
  // Multiplayer
  | "player_join"
  | "player_leave"
  | "player_locked"
  | "all_locked"
  | "round_end_mp"
  // Bidding
  | "bidding_shuffle"
  | "spotlight_activate"
  | "bid_reveal"
  | "bid_dock"
  // Mode-specific
  | "riser_launch"
  | "riser_flying"
  | "riser_stop"
  | "button_click"
  | "slider_tick"
  | "item_select"
  | "item_deselect"
  | "swap"
  | "chain_link"
  | "correct"
  | "incorrect";

/**
 * Definition for a procedural sound effect. Each sound knows how to
 * create and schedule its own Web Audio nodes.
 */
export interface SoundDefinition {
  /**
   * Generate and schedule the sound. Returns a stop function for
   * loopable or long-running sounds, or void for fire-and-forget.
   */
  play(ctx: AudioContext, destination: AudioNode): (() => void) | void;
  /** If true, multiple overlapping instances are allowed. */
  polyphonic?: boolean;
}
