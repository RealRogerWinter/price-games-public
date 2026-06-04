/**
 * Shared mood registry — single source of truth for the bot streamer's
 * "Pricey" mood vocabulary. Lives in `@price-game/shared` so the bot
 * runner, the server's stats relay validator, and the web overlay bus
 * + indicator panel all agree on the label set without ad-hoc
 * duplicate allowlists drifting apart.
 *
 * Adding a mood now means: (1) extend `MOOD_LABELS`, (2) add a row to
 * `MOOD_REGISTRY`. Every consumer picks it up automatically.
 *
 * The descriptor metadata (color, emoji, displayLabel, description) is
 * the contract the indicator panel renders against. We deliberately
 * keep it small and presentation-focused; the engine-side state
 * machine stays in `packages/bot-streamer/src/persona/mood.ts` and is
 * free to evolve (vibe decay, morale, additional inputs) without
 * touching this registry, as long as it only emits labels from
 * `MOOD_LABELS`.
 */

/**
 * Canonical mood labels. Order is the rendering precedence the
 * indicator uses for tie-breaking and tests use for exhaustiveness
 * iteration. `as const` so the derived `Mood` union stays a string
 * literal type.
 *
 * Expanded in PR 4 from 4 → 8 labels to support the v2 engine's
 * vibe + morale model. The four originals (neutral / happy /
 * frustrated / focused) are joined by:
 *   - confident (positive morale + winning streak)
 *   - elated    (high vibe AND high morale)
 *   - tilted    (mild negative trend, before full frustration)
 *   - despondent (low morale AND low vibe)
 *
 * The new labels share sprite assets with the originals via each
 * descriptor's `spriteFallback` field — PR 5 generates dedicated
 * sprites and updates the fallbacks.
 */
export const MOOD_LABELS = [
  "neutral",
  "happy",
  "confident",
  "elated",
  "focused",
  "tilted",
  "frustrated",
  "despondent",
] as const;

export type Mood = typeof MOOD_LABELS[number];

/**
 * Type guard — narrow an arbitrary string to `Mood` at validation
 * boundaries (server POST body, postMessage envelope, sessionStorage
 * hydrate). Returns false for null/undefined/unknown labels.
 */
export function isMood(value: unknown): value is Mood {
  return typeof value === "string" && (MOOD_LABELS as readonly string[]).includes(value);
}

/**
 * Voice prosody for a mood — how Pricey *sounds* when speaking lines
 * tagged with this mood. Exposes the three Piper inference knobs that
 * meaningfully change perceived emotion without changing the voice
 * model: pacing (`length_scale`), expressiveness (`noise_scale`), and
 * cadence variability (`noise_w`). Pitch is voice-model-dependent and
 * the streamer ships a single voice today, so we leave that lever off
 * the descriptor until multi-voice support lands.
 */
export interface MoodProsody {
  /**
   * Piper `--length_scale` value (utterance pacing).
   *   < 1.0  → faster speech
   *   = 1.0  → neutral speech
   *   > 1.0  → slower speech
   * Practical range ~0.85 – 1.20 — outside that the result either
   * clips syllables (too fast) or sounds drugged (too slow).
   */
  readonly lengthScale: number;
  /**
   * Piper `--noise_scale` value (acoustic / expressive variability).
   * Controls how much per-frame variation the vocoder adds: low values
   * sound polished and steady, high values sound livelier with more
   * timbral movement. Piper's model default is 0.667. We bracket
   * [0.45, 0.85]: deflated moods (despondent, focused) drop below the
   * default for a flat affect; excited moods (elated, tilted) push
   * above for animation without crossing into the artefacted-buzzing
   * zone past ~1.0.
   */
  readonly noiseScale: number;
  /**
   * Piper `--noise_w` value (phoneme-duration jitter — affects rhythmic
   * variation between syllables). Higher values produce more uneven
   * cadence — syllables stretch and compress more — which reads as
   * heightened emotion or restlessness. Piper's model default is 0.8.
   * We bracket [0.65, 1.00]: focused / despondent stay close to even
   * cadence; elated / tilted push toward the upper end so the rhythm
   * itself communicates the mood independent of pacing.
   */
  readonly noiseW: number;
}

/**
 * Display metadata for a single mood. Consumed by the indicator panel
 * and the operator-facing debug HUD. Kept presentational only — no
 * gameplay-behavioural fields here so the indicator isn't accidentally
 * driving game logic.
 */
export interface MoodDescriptor {
  /** Stable label key. Matches the union member. */
  readonly label: Mood;
  /** Human-readable display string. Title case. */
  readonly displayLabel: string;
  /** Hex colour for the indicator chip + label glow. */
  readonly color: string;
  /** Emoji glyph for compact representations. */
  readonly emoji: string;
  /** One-line viewer-facing description. Used in tooltips / aria-label. */
  readonly description: string;
  /**
   * Sprite-asset fallback. Historically pointed each new mood at one
   * of the four "anchor" moods (neutral / happy / frustrated /
   * focused) whose sprite files existed on disk. PR 5 generated
   * dedicated body sprites for the four PR 4 moods so every mood
   * now points spriteFallback at itself (the field is the identity
   * function for the current vocabulary). Kept on the descriptor in
   * case a future PR introduces a mood whose sprite hasn't been
   * generated yet — that mood can fall back to an anchor without an
   * Avatar code change.
   */
  readonly spriteFallback: Mood;
  /**
   * Voice prosody — drives `--length_scale` on the Piper subprocess
   * for any line spoken under this mood. Wired through
   * `narrator.dispatch` → `engine.say(line, opts)` → `piperEngine`.
   * See {@link MoodProsody} for the value space.
   */
  readonly prosody: MoodProsody;
}

/**
 * Registry row per mood. Centralised here so adding a mood doesn't
 * require touching the overlay bus reducer, the server validator, the
 * indicator panel, the debug HUD, and the bot's MoodState type
 * separately — the duplication that earlier mood iterations suffered.
 */
export const MOOD_REGISTRY: Readonly<Record<Mood, MoodDescriptor>> = {
  neutral: {
    label: "neutral",
    displayLabel: "Neutral",
    color: "#cbd5e1",
    emoji: "🙂",
    description: "Steady — neither winning nor losing streaks.",
    spriteFallback: "neutral",
    // Piper model defaults — neutral is the calibration anchor every
    // other mood is described relative to.
    prosody: { lengthScale: 1.00, noiseScale: 0.667, noiseW: 0.80 },
  },
  happy: {
    label: "happy",
    displayLabel: "Happy",
    color: "#34d399",
    emoji: "😄",
    description: "Riding a positive vibe from recent wins.",
    spriteFallback: "happy",
    // Faster + a touch more expressive than neutral — reads as "lift".
    prosody: { lengthScale: 0.95, noiseScale: 0.75, noiseW: 0.90 },
  },
  confident: {
    label: "confident",
    displayLabel: "Confident",
    color: "#a3e635",
    emoji: "😎",
    description: "Long-running positive morale; trusting the read.",
    spriteFallback: "confident",
    // Slightly faster than neutral but steadier (lower noise) — confidence
    // reads as polished / unrushed rather than excited.
    prosody: { lengthScale: 0.97, noiseScale: 0.55, noiseW: 0.70 },
  },
  elated: {
    label: "elated",
    displayLabel: "Elated",
    color: "#fbbf24",
    emoji: "🤩",
    description: "Both vibe and morale are high — Pricey is rolling.",
    spriteFallback: "elated",
    // Fastest pacing + most expressive variation — breathless excitement.
    prosody: { lengthScale: 0.90, noiseScale: 0.85, noiseW: 1.00 },
  },
  focused: {
    label: "focused",
    displayLabel: "Focused",
    color: "#60a5fa",
    emoji: "🧐",
    description: "Locked in on a streak — same direction, multiple rounds.",
    spriteFallback: "focused",
    // Slightly slower with the steadiest cadence of any mood — focused
    // reads as measured / deliberate.
    prosody: { lengthScale: 1.05, noiseScale: 0.50, noiseW: 0.65 },
  },
  tilted: {
    label: "tilted",
    displayLabel: "Tilted",
    color: "#fb923c",
    emoji: "😬",
    description: "Vibe trending down — a few more losses and it tips.",
    spriteFallback: "tilted",
    // Slower pacing but high variability — tilted reads as agitated /
    // jittery underneath the slowed delivery.
    prosody: { lengthScale: 1.05, noiseScale: 0.80, noiseW: 0.95 },
  },
  frustrated: {
    label: "frustrated",
    displayLabel: "Frustrated",
    color: "#f87171",
    emoji: "😤",
    description: "Recent losses are dragging the vibe down.",
    spriteFallback: "frustrated",
    // Slow + sharp / uneven — irritation, not flatness.
    prosody: { lengthScale: 1.10, noiseScale: 0.75, noiseW: 0.90 },
  },
  despondent: {
    label: "despondent",
    displayLabel: "Despondent",
    color: "#a855f7",
    emoji: "😞",
    description: "Long losing morale on top of a bad streak — Pricey's beat.",
    spriteFallback: "despondent",
    // Slowest pacing + flattest affect — defeated, dragging, no lift in
    // either expressiveness or cadence.
    prosody: { lengthScale: 1.15, noiseScale: 0.45, noiseW: 0.70 },
  },
};

/**
 * Default mood when no signal has been published yet. Centralised
 * so the overlay reducer's INITIAL_STATE and the bot's INITIAL_MOOD
 * stay aligned on the same starting label.
 */
export const DEFAULT_MOOD: Mood = "neutral";
