/**
 * Bot persona — name, avatar slug, skill temperature, optional voice
 * config. Configured at container start via env vars; the runner reads
 * the resolved profile and propagates name/avatar to localStorage so the
 * production game treats the bot as a regular client.
 */

import { DEFAULT_AVATAR } from "@price-game/shared";

export interface PersonaProfile {
  /** Display name shown in lobbies and the broadcast overlay. */
  name: string;
  /** Avatar slug from the existing AVATARS list (sticker-pop set). */
  avatar: string;
  /**
   * Softmax temperature applied to strategy candidates. 0 = always
   * pick the best candidate; ~0.3 = competent player; ~1.0 ≈ random
   * over plausible options. Defaults to 0.35.
   */
  skillTemperature: number;
  /**
   * Strength of mood's influence on the bot's decision pipeline,
   * range [0, 1]. 0 = mood is purely cosmetic (UI, TTS prosody) —
   * the candidate-sampler temperature and ε-greedy probability are
   * unaffected, and the FiLM head (when present) skips its forward
   * pass. 1 = full mood-conditioned pipeline (default).
   *
   * Default ramp history: 0 across PRs #298–#302 (the integration +
   * Eldar-Niv credit gain) while shadow-mode + adversarial vitests
   * gated correctness; flipped to 1 in the cleanup PR once both
   * commit ranges had landed clean. Operators wanting to revert
   * to inert can set `STREAMER_MOOD_INFLUENCE=0` and restart the
   * container — same kill-switch shape as `STREAMER_SKILL_TEMPERATURE`.
   */
  moodInfluence: number;
  /**
   * Phase 3d.2: bidding-aggressiveness knob ∈ [0, 1]. Drives the
   * bidding decoder's quantile aggressiveness, clip/gambit
   * thresholds, and σ-floor on the opponent simulator. Separate
   * from `moodInfluence` so operators can tune competitiveness
   * without enabling persona-mood drift on the bidding head.
   *
   * Default 0.7 = "clearly trying, occasionally human-foolish."
   * Override with `STREAMER_COMPETITIVENESS=<0..1>`.
   */
  competitiveness: number;
  /**
   * Optional Piper voice model name (e.g. "en_US-amy-medium"). When
   * unset, the streamer container falls back to its default voice.
   */
  voice?: string;
}

export const DEFAULT_PERSONA: PersonaProfile = {
  name: "Pricey",
  avatar: DEFAULT_AVATAR,
  skillTemperature: 0.35,
  // Live by default. The mood pipeline shipped inert across PRs
  // #298 + #302; the cleanup PR flips this to 1 once the FiLM /
  // signedCreditGain integrations had landed clean and the
  // adversarial vitests had pinned the lock-in invariants.
  // Override with `STREAMER_MOOD_INFLUENCE=0` if you need the
  // bot to behave as it did pre-PR-298.
  moodInfluence: 1,
  // Phase 3d.2 default — clearly competitive but not optimal.
  competitiveness: 0.7,
};

/**
 * Build a persona from environment variables. Unknown / out-of-range
 * fields fall back to the defaults so a missing or fat-fingered env
 * var never crashes the runner — the bot just runs as Pricey.
 *
 * @param env Environment object (defaults to `process.env`).
 * @returns Resolved persona, never throws.
 */
export function loadPersonaFromEnv(env: NodeJS.ProcessEnv = process.env): PersonaProfile {
  const name =
    typeof env.STREAMER_BOT_DISPLAY_NAME === "string" && env.STREAMER_BOT_DISPLAY_NAME.trim()
      ? env.STREAMER_BOT_DISPLAY_NAME.trim().slice(0, 32)
      : DEFAULT_PERSONA.name;
  const avatar =
    typeof env.STREAMER_BOT_AVATAR === "string" && /^[a-z0-9_-]+$/i.test(env.STREAMER_BOT_AVATAR)
      ? env.STREAMER_BOT_AVATAR
      : DEFAULT_PERSONA.avatar;
  const tempRaw = Number(env.STREAMER_SKILL_TEMPERATURE);
  const skillTemperature = Number.isFinite(tempRaw) && tempRaw >= 0 && tempRaw <= 5
    ? tempRaw
    : DEFAULT_PERSONA.skillTemperature;
  // moodInfluence is the master gate on the mood→decision pipeline.
  // Empty / whitespace env var falls through to the default (1.0 —
  // live) — matters now that 0 is the kill-switch value, not the
  // default; without the explicit `"" → default` step, `Number("")`
  // would silently return 0 and disable mood for any deployment
  // that exports the env var as the empty string. Validated to
  // [0, 1] otherwise; out-of-range also falls back to the default.
  // Operators reverting to inert pass a syntactically valid
  // `STREAMER_MOOD_INFLUENCE=0`.
  const moodEnv = typeof env.STREAMER_MOOD_INFLUENCE === "string"
    ? env.STREAMER_MOOD_INFLUENCE.trim()
    : "";
  const moodRaw = moodEnv === "" ? Number.NaN : Number(moodEnv);
  const moodInfluence = Number.isFinite(moodRaw) && moodRaw >= 0 && moodRaw <= 1
    ? moodRaw
    : DEFAULT_PERSONA.moodInfluence;
  // Phase 3d.2: STREAMER_COMPETITIVENESS — same parsing shape as
  // moodInfluence (empty / out-of-range → default).
  const compEnv = typeof env.STREAMER_COMPETITIVENESS === "string"
    ? env.STREAMER_COMPETITIVENESS.trim()
    : "";
  const compRaw = compEnv === "" ? Number.NaN : Number(compEnv);
  const competitiveness = Number.isFinite(compRaw) && compRaw >= 0 && compRaw <= 1
    ? compRaw
    : DEFAULT_PERSONA.competitiveness;
  // The voice slug flows into the Piper CLI subprocess args in PR 13.
  // Constrain it to a safe character set + length now so an env-var
  // typo (or malicious config) can't introduce a shell-injection
  // vector once the consumer exists.
  const voiceRaw = typeof env.STREAMER_TTS_VOICE === "string" ? env.STREAMER_TTS_VOICE.trim() : "";
  const voice =
    voiceRaw.length > 0 && voiceRaw.length <= 64 && /^[A-Za-z0-9_-]+$/.test(voiceRaw)
      ? voiceRaw
      : undefined;
  return { name, avatar, skillTemperature, moodInfluence, competitiveness, voice };
}
