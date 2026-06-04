/**
 * Chat command bindings — wires the canonical viewer commands
 * (`!mode`, `!hint`, `!skill`, `!song`, `!stats`, `!join`) to runner
 * state via a small mutable state object the runner reads on every
 * loop tick.
 *
 * The state shape is intentionally narrow: all the commands need is
 * a way to nudge the runner's next plan / temperature / TTS path.
 * The runner doesn't depend on this module — chat is entirely
 * optional and a deployment without Twitch credentials simply skips
 * the wiring.
 */

import type { GameMode } from "@price-game/shared";
import { MULTIPLAYER_ONLY_MODES, VALID_GAME_MODES } from "@price-game/shared";
import type { CommandRouter } from "../chat/router";
import type { Narrator } from "./narrator";
import { INITIAL_MOOD, type MoodState } from "../persona/mood";
import type { OpponentTracker } from "../strategies/biddingOpponents";

export interface RunnerCommandState {
  /**
   * When set, the next plan's mode is overridden to this value (one-
   * shot). Cleared as soon as the runner reads it. Set by `!mode`.
   */
  nextModeOverride: GameMode | null;
  /**
   * Live skill temperature. The runner reads this when sampling
   * candidates each round so a `!skill` command takes effect on the
   * next decision, not requiring a restart.
   */
  skillTemperature: number;
  /**
   * Last decision rationale the bot considered. `!hint` re-narrates
   * this so viewers can hear why the bot picked what it picked.
   */
  lastRationale: string | null;
  /**
   * Stat counters for `!stats`. Updated by the runner once per
   * **game** (not per round): the runner accumulates per-round
   * scores into `currentGameScore` during a plan, and the plan
   * executors (`executeSolo` / `executePublicJoin` / `executeHostPublic`)
   * call `finalizeGameOutcome()` at the end of the plan to bump
   * `wins`/`losses`/`streak` exactly once, based on point total.
   *
   * Streak is decoupled from `moodState.streak` (which still reacts
   * per-round to drive the bot's emoji/mood). Game streak goes
   * positive on consecutive wins (`+1`, `+2`, …) and negative on
   * consecutive losses (`-1`, `-2`, …); a single win/loss after the
   * opposite outcome resets to `+1` / `-1`.
   */
  wins: number;
  losses: number;
  streak: number;
  /**
   * Per-game accumulators reset by `finalizeGameOutcome()`.
   *
   * `currentGameScore` is the running sum of the bot's scores within
   * the active plan. For solo it's the only signal we have (no
   * standings); for MP it's a sanity-check side channel.
   *
   * `currentGameRoundsObserved` is bumped only when a round produced
   * a real outcome (a `RoundOutcomeView`). Plans that observed zero
   * rounds — e.g. all dropped `round_end`s, malformed solo guess
   * responses — are skipped entirely on finalize, so a totally-failed
   * plan doesn't credit a phantom loss.
   */
  currentGameScore: number;
  currentGameRoundsObserved: number;
  /**
   * Mood state — drives mood emoji on overlay BotCard and biases
   * narrator line variants. Updated by the runner after each round
   * result via `nextMood()`.
   */
  moodState: MoodState;
  /**
   * Currently-playing music track in human-readable form ("Title by
   * Artist"). Maintained by the music source (`runner/musicSource.ts`)
   * which subscribes to `mpc idleloop player` events; consumed by the
   * `!song` chat command.
   */
  nowPlaying: string | null;
  /**
   * Bot's current public room code, when hosting. `!join` echoes
   * this so viewers can hop in.
   */
  hostedRoomCode: string | null;
  /**
   * Phase 3d.2: per-game opponent posterior. Built when a
   * `quickplay_bidding` plan starts; updated on each `bid_placed` +
   * reveal; cleared on game over. The bidding decoder reads
   * `snapshot()` to simulate later opponents' bids when scoring
   * candidates. Null on every other plan kind.
   */
  opponentTracker: OpponentTracker | null;
}

export function createInitialCommandState(skillTemperature: number): RunnerCommandState {
  return {
    nextModeOverride: null,
    skillTemperature,
    lastRationale: null,
    wins: 0,
    losses: 0,
    streak: 0,
    currentGameScore: 0,
    currentGameRoundsObserved: 0,
    moodState: { ...INITIAL_MOOD },
    nowPlaying: null,
    hostedRoomCode: null,
    opponentTracker: null,
  };
}

const SKILL_TO_TEMPERATURE: Record<string, number> = {
  easy: 0.9,
  normal: 0.35,
  hard: 0.05,
};

interface RegisterOptions {
  router: CommandRouter;
  state: RunnerCommandState;
  narrator?: Narrator;
}

/**
 * Register the canonical commands on `router`. Idempotent — calling
 * twice replaces the handlers.
 *
 * @param opts.router   Router instance to register on.
 * @param opts.state    Mutable state object the runner reads.
 * @param opts.narrator Optional narrator — when present, commands
 *                      that have a spoken response (e.g. !hint, mod
 *                      acks) trigger TTS via narrator.say().
 */
export function registerChatCommands(opts: RegisterOptions): void {
  const { router, state, narrator } = opts;

  router.register({
    name: "mode",
    rateLimit: { perUserSeconds: 60, globalSeconds: 5 },
    handler: async (cmd) => {
      const requested = cmd.args[0]?.toLowerCase();
      if (!requested) return;
      if (!VALID_GAME_MODES.has(requested)) return;
      // Multiplayer-only modes (e.g. bidding) can't be played via a
      // solo plan — the web app rejects /play/<mp-only-mode>. Drop
      // the override silently rather than route the bot to a 404.
      // Viewers who want to see the bot in MP can wait for the
      // host_public step in the rotation and use !join.
      if (MULTIPLAYER_ONLY_MODES.has(requested)) return;
      state.nextModeOverride = requested as GameMode;
      await narrator?.speak("ack_mode", state.moodState.mood);
    },
  });

  router.register({
    name: "hint",
    rateLimit: { perUserSeconds: 120, globalSeconds: 10 },
    handler: async () => {
      if (!state.lastRationale) return;
      // Mood-tagged lead-in via speak() so prosody applies, then the
      // literal rationale via say() (no mood-bound TTS for variable
      // text). The narrator's engine queue serializes them so the
      // viewer hears them as a single thought.
      await narrator?.speak("ack_hint_lead", state.moodState.mood);
      await narrator?.say(state.lastRationale);
    },
  });

  router.register({
    name: "skill",
    rateLimit: { perUserSeconds: 300, globalSeconds: 30, modOnly: true },
    handler: async (cmd) => {
      const tier = cmd.args[0]?.toLowerCase();
      const value = tier !== undefined ? SKILL_TO_TEMPERATURE[tier] : undefined;
      if (typeof value !== "number") return;
      state.skillTemperature = value;
      await narrator?.speak("ack_skill", state.moodState.mood);
    },
  });

  router.register({
    name: "song",
    rateLimit: { perUserSeconds: 15, globalSeconds: 5 },
    handler: async () => {
      const line = state.nowPlaying ?? "I'm not sure what's playing right now.";
      await narrator?.speak("ack_song_lead", state.moodState.mood);
      await narrator?.say(line);
    },
  });

  router.register({
    name: "stats",
    rateLimit: { perUserSeconds: 20, globalSeconds: 5 },
    handler: async () => {
      const total = state.wins + state.losses;
      const winRate = total > 0 ? Math.round((state.wins / total) * 100) : 0;
      const line = `${state.wins} wins, ${state.losses} losses — ${winRate}% win rate, current streak ${state.streak}.`;
      await narrator?.speak("ack_stats_lead", state.moodState.mood);
      await narrator?.say(line);
    },
  });

  router.register({
    name: "join",
    rateLimit: { perUserSeconds: 5, globalSeconds: 5 },
    handler: async () => {
      const code = state.hostedRoomCode;
      await narrator?.speak("ack_join_lead", state.moodState.mood);
      if (!code) {
        await narrator?.say("I'm playing solo right now — hosting a public room next round.");
        return;
      }
      await narrator?.say(`Hop in! Room code is ${code}.`);
    },
  });
}
