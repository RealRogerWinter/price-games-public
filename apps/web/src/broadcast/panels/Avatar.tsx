/**
 * Animated streamer-bot avatar — Path B (image-edit-coherent set,
 * full-body sprite swap).
 *
 * Three full-body Pricey sprites per mood (closed, mid, wide), all
 * 384×384 with body identity preserved across the three by the
 * image-edit pipeline. Drive them by toggling opacity 0↔1 on the
 * one sprite that matches the current mouth state — a discrete
 * picker (not an opacity blend) since the v3 sprites carry chromakey'd
 * transparent backgrounds and overlapping any two of them additively
 * produces a faint pink rim.
 *
 * Earlier approach (deprecated): one body sprite + two mouth-only
 * overlays. The v2 mouth overlays were 512×512 while the body
 * sprites were 384×384, and `object-fit: contain` placed each at
 * its OWN canvas's relative coordinates — so the overlay's painted
 * mouth landed off to the side of the body's painted mouth and the
 * opacity flip was visually invisible. Symptom in production: the
 * mouth never appeared to animate during speech even though the
 * runner-side PCM was being correctly tapped, batched, dispatched,
 * and the page-side `apertureEvents` counter ticked at the syllable
 * rate. See docs/STREAMER.md for the full debugging history.
 */

import { useEffect, useRef } from "react";
import { DEFAULT_MOOD, type Mood } from "@price-game/shared";
import {
  pcmEvents,
  drainPcmReplayQueue,
  isSpeaking as isSpeakingSelector,
  type PcmChunkDetail,
  type BotStats,
  type CurrentUtterance,
} from "../state/overlayBus";
// v3 closed-mouth bodies (one per mood). The v2 mood sprites were the
// originals but rendered the pig at a different relative position
// inside the source raster than Gemini's image-edit output (notably,
// `pricey-v2-mouth-closed.webp` was 512×512 vs all other v2 moods at
// 384×384). To guarantee zero-jump alignment between closed → mid →
// wide we re-pushed every closed sprite through the SAME generate +
// chromakey + scale-to-384 pipeline that produced the mid/wide PNGs.
// All 24 sprites now share identical canvas coordinates and the
// painted Pricey lands at the exact same x/y across the trio for
// every mood.
import imgClosedNeutral from "../../assets/avatar/pricey-v3-mouth-neutral-closed.webp";
import imgClosedHappy from "../../assets/avatar/pricey-v3-mouth-happy-closed.webp";
import imgClosedConfident from "../../assets/avatar/pricey-v3-mouth-confident-closed.webp";
import imgClosedElated from "../../assets/avatar/pricey-v3-mouth-elated-closed.webp";
import imgClosedFocused from "../../assets/avatar/pricey-v3-mouth-focused-closed.webp";
import imgClosedTilted from "../../assets/avatar/pricey-v3-mouth-tilted-closed.webp";
import imgClosedFrustrated from "../../assets/avatar/pricey-v3-mouth-frustrated-closed.webp";
import imgClosedDespondent from "../../assets/avatar/pricey-v3-mouth-despondent-closed.webp";
// v3 mid-open mouth (small "oh" shape) per mood.
import imgMidNeutral from "../../assets/avatar/pricey-v3-mouth-neutral-mid.webp";
import imgMidHappy from "../../assets/avatar/pricey-v3-mouth-happy-mid.webp";
import imgMidConfident from "../../assets/avatar/pricey-v3-mouth-confident-mid.webp";
import imgMidElated from "../../assets/avatar/pricey-v3-mouth-elated-mid.webp";
import imgMidFocused from "../../assets/avatar/pricey-v3-mouth-focused-mid.webp";
import imgMidTilted from "../../assets/avatar/pricey-v3-mouth-tilted-mid.webp";
import imgMidFrustrated from "../../assets/avatar/pricey-v3-mouth-frustrated-mid.webp";
import imgMidDespondent from "../../assets/avatar/pricey-v3-mouth-despondent-mid.webp";
// v3 wide-open mouth (big yelling shape) per mood.
import imgWideNeutral from "../../assets/avatar/pricey-v3-mouth-neutral-wide.webp";
import imgWideHappy from "../../assets/avatar/pricey-v3-mouth-happy-wide.webp";
import imgWideConfident from "../../assets/avatar/pricey-v3-mouth-confident-wide.webp";
import imgWideElated from "../../assets/avatar/pricey-v3-mouth-elated-wide.webp";
import imgWideFocused from "../../assets/avatar/pricey-v3-mouth-focused-wide.webp";
import imgWideTilted from "../../assets/avatar/pricey-v3-mouth-tilted-wide.webp";
import imgWideFrustrated from "../../assets/avatar/pricey-v3-mouth-frustrated-wide.webp";
import imgWideDespondent from "../../assets/avatar/pricey-v3-mouth-despondent-wide.webp";

/**
 * Per-mood × per-mouth-state sprite map. Each mood ships THREE full
 * body sprites (closed, mid, wide) with body identity preserved by
 * the image-edit pipeline — only the mouth shape differs across the
 * three. Driving the avatar by swapping which sprite is opaque (vs.
 * the previous overlay approach) eliminates the alignment problem
 * that came from compositing two differently-sized canvases on top of
 * each other (the v2 mouth overlays were 512×512, body sprites were
 * 384×384, and `object-fit: contain` placed each at its own canvas's
 * relative coordinates — so the overlay's painted mouth landed off
 * to the side of the body's painted mouth and the swap was invisible).
 *
 * Statically imported so Vite bundles all 24 WebPs at build time —
 * runtime swaps are a constant-time dictionary lookup with no chunk
 * fetch or paint stall on the first speaking syllable.
 *
 * The CSS `transform: scaleX(-1)` on `.broadcast-avatar-frame` flips
 * each sprite horizontally so Pricey faces RIGHT on screen. All
 * source files are stored facing LEFT (snout on the left side of the
 * raster) so the flip lands them facing right uniformly.
 */
const BODY_BY_MOOD: Record<Mood, { closed: string; mid: string; wide: string }> = {
  neutral: { closed: imgClosedNeutral, mid: imgMidNeutral, wide: imgWideNeutral },
  happy: { closed: imgClosedHappy, mid: imgMidHappy, wide: imgWideHappy },
  confident: { closed: imgClosedConfident, mid: imgMidConfident, wide: imgWideConfident },
  elated: { closed: imgClosedElated, mid: imgMidElated, wide: imgWideElated },
  focused: { closed: imgClosedFocused, mid: imgMidFocused, wide: imgWideFocused },
  tilted: { closed: imgClosedTilted, mid: imgMidTilted, wide: imgWideTilted },
  frustrated: { closed: imgClosedFrustrated, mid: imgMidFrustrated, wide: imgWideFrustrated },
  despondent: { closed: imgClosedDespondent, mid: imgMidDespondent, wide: imgWideDespondent },
};

interface AvatarProps {
  /**
   * Active utterance from the overlay bus's `currentUtterance` slot,
   * or null when nothing is being spoken. Drives the `is-speaking`
   * class and the snap-mouth-closed effect via the `isSpeaking`
   * selector. PR 3 swap: replaces the legacy `tts: TtsState` prop
   * (driven by speakingClock heuristics) with the single-source-of-
   * truth slot reduced from `tts.utterance.*` envelopes.
   */
  currentUtterance: CurrentUtterance | null;
  /** Current mood. Selects the body sprite via `BODY_BY_MOOD`. */
  mood?: BotStats["mood"];
}

/**
 * Asymmetric envelope follower constants. Per-chunk coefficients
 * assuming 40ms PCM chunks (Piper default):
 *   τ_attack  ≈ 60ms  → α ≈ 0.49
 *   τ_release ≈ 60ms  → α ≈ 0.50
 *
 * Tuned for the discrete mouth state machine: attack is fast so the
 * `wide` state pops on word peaks immediately; release was bumped
 * up from 0.34 → 0.50 (~95ms → ~60ms time constant) so the envelope
 * decays back through `mid` and into `closed` within a single
 * inter-syllable gap (~80-120ms). Combined with the removal of the
 * aperture-hold floor, this restores per-syllable mouth modulation
 * — without the bump the envelope rarely fell back to closed during
 * a typical streaming line and the mouth read as "open the whole
 * time, with two big openings".
 */
const ATTACK_ALPHA = 0.49;
const RELEASE_ALPHA = 0.50;

/** RMS → aperture compression. Real Piper RMS measured in production
 *  (logged via runner-side `pcm.diag` rmsMax/rmsMean) ranges 0–0.40
 *  with mean ≈ 0.10 and peaks ≈ 0.30–0.40 during steady speech. The
 *  prior gain of 9 mapped mean RMS to aperture 0.72 — already deep in
 *  the wide band — so the envelope sat pinned at wide for the entire
 *  utterance and word peaks just saturated at 1.0. With gain 3.5,
 *  mean RMS ≈ 0.10 lands at 0.28 (mid) and word peaks at RMS ≈ 0.30+
 *  push into wide, restoring per-syllable mouth dynamics that match
 *  what the synthetic-PCM sandbox test produces. RMS_FLOOR stays at
 *  0.02 to suppress room-noise twitches. */
function rmsToAperture(rms: number): number {
  const RMS_FLOOR = 0.02;
  const GAIN = 3.5;
  const v = Math.max(0, rms - RMS_FLOOR) * GAIN;
  return Math.min(1, v);
}

function rmsOf(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  return Math.sqrt(sumSq / samples.length) / 32768;
}

/**
 * Pure helper: return the open-mouth overlay opacity for a given
 * aperture. Single overlay — the body's painted closed smile shows
 * through whenever this opacity is below 1, naturally producing
 * the visual range [closed → ajar → small open → wide open] from
 * a single image. Exposed for unit tests.
 *
 * The mapping is steep on purpose: any meaningful speech amplitude
 * commits the mouth to high opacity rather than hovering at 30-40%
 * (which read as "almost transparent / barely visible"). Below
 * `OPEN_FLOOR` the overlay is fully transparent so silence-noise
 * twitches don't flicker the mouth.
 */
/**
 * Mouth state machine — picks exactly ONE of (closed, mid, wide)
 * based on aperture. Single-overlay opacity blending was too subtle
 * (the body's painted closed smile + a faded wide-open mouth
 * registered as "always open" because both shapes overlap visually).
 * Discrete state-switching with two distinct overlay shapes gives
 * actual mouth-movement readability:
 *
 *   closed   – body sprite alone (its painted smile is the mouth shape)
 *   mid      – small "oh" overlay, body's smile occluded
 *   wide     – big "AHHH" overlay, body's smile occluded
 *
 * Thresholds were chosen so steady-state speech sits in `mid` and
 * loud syllable peaks pop into `wide` for ~100-200ms before
 * relaxing back. Silence drops to `closed`. The CSS `transition:
 * opacity 80ms linear` on the overlay images animates the discrete
 * swaps so they read as mouth-shape morphs rather than hard cuts.
 */
export type MouthState = "closed" | "mid" | "wide";

// Thresholds tuned for visible rhythm during continuous speech.
// With Piper-shaped audio at typical streaming amplitudes, the
// envelope spends time both sides of WIDE during each word — wide
// dominates the loud portion, mid during decays and inter-word
// gaps, closed during real silences. A WIDE threshold above ~0.4
// pinned the mouth on mid with rare wide flashes; below ~0.2
// pinned it on wide with rare mid flashes. 0.30 sits in the sweet
// spot where each word's loud-peak crosses up and decay-tail
// crosses down, producing 2-3 visible swaps per word.
const APERTURE_TO_MID = 0.10;
const APERTURE_TO_WIDE = 0.30;

/**
 * Phantom-syllable apertures cycled through during the anticipation
 * window — the gap between `tts.utterance.start` (T0) and the first
 * real PCM chunk arriving at the page (~80–150ms later). The earlier
 * lead-in seeded a single static aperture (0.20 → mid) and held it
 * until real PCM took over; viewers read that as "mouth ajar, holding
 * still" rather than "speaking", so the lead-in fixed the timing of
 * the OPENING but not the timing of the ANIMATION. Cycling through a
 * coarse pulse pattern at ~12Hz produces visible state changes — one
 * fake syllable's worth of motion — that bridge the gap.
 *
 * Pattern values are picked to alternate between the `mid` band
 * ([APERTURE_TO_MID, APERTURE_TO_WIDE)) and the `wide` band
 * ([APERTURE_TO_WIDE, 1]) so each tick crosses a state boundary and
 * `applyAperture` actually writes a different opacity. The starting
 * value (0.20) sits at mid with margin — same as the previous static
 * lead-in — so the very first frame still reads as "starting to
 * speak" before the first transition lands.
 *
 * When the first real PCM chunk fires, the chunk listener overwrites
 * `envelopeRef` with an attack-smoothed RMS value; the smoothing
 * (alpha 0.49) means the envelope converges to the true RMS in 2–3
 * chunks regardless of where the phantom pattern left it. So a brief
 * visual mismatch at the seam is bounded and self-correcting.
 */
const PHANTOM_PATTERN = [0.20, 0.50, 0.22, 0.55] as const;

/**
 * Tick interval for the phantom-syllable cycle. 80ms ≈ 12.5Hz, slow
 * enough for the 80ms CSS opacity transition to finish painting one
 * state before the next write retargets it (writes faster than the
 * transition cause the compositor to never visibly land on a state —
 * see `applyAperture`'s dedup-guard rationale).
 */
const PHANTOM_TICK_MS = 80;

/**
 * Hard cap on the phantom-syllable loop. Steady-state Piper warmup is
 * 60–100ms; under heavy load it can stretch to ~150ms; beyond that
 * the runner is likely stalled (or audio_started got dropped). The
 * cap ensures the loop can't run unbounded if `audioStartedAt` never
 * flips for some pathological reason — after this many ms the mouth
 * holds at the most recent phantom value and waits for either the
 * snap-closed effect (audio_ended) or a fresh utterance to take over.
 */
const PHANTOM_MAX_MS = 500;

export function mouthStateFor(aperture: number): MouthState {
  if (aperture < APERTURE_TO_MID) return "closed";
  if (aperture < APERTURE_TO_WIDE) return "mid";
  return "wide";
}

/** Diagnostic counters; kept under the existing window key for tooling continuity. */
interface AvatarDiagStats {
  processed: number;
  lastRms: number | null;
  lastAperture: number | null;
  apertureEvents: number;
  lastSampleCount: number | null;
}

function ensureStats(): AvatarDiagStats {
  const empty: AvatarDiagStats = {
    processed: 0,
    lastRms: null,
    lastAperture: null,
    apertureEvents: 0,
    lastSampleCount: null,
  };
  if (typeof window === "undefined") return empty;
  const w = window as unknown as { __pgVisemeStats?: AvatarDiagStats };
  if (!w.__pgVisemeStats) w.__pgVisemeStats = empty;
  return w.__pgVisemeStats;
}

/**
 * Pricey, the streamer-bot piggy-bank mascot. Three stacked body
 * sprites per mood (closed, mid, wide); a smoothed RMS amplitude
 * envelope picks one via `mouthStateFor` and `applyAperture` toggles
 * which one is at opacity 1. CSS animates the 0↔1 flip over 80ms so
 * the discrete swap reads as a mouth-shape morph.
 *
 * @param props.currentUtterance Latest utterance lifecycle slot. While
 *                   `isSpeaking(currentUtterance)` is true (i.e.
 *                   `audioStartedAt` is set and `audioEndedAt` is not),
 *                   PCM chunks from the overlay bus drive the envelope.
 *                   Snap mouth closes the moment `audioEndedAt` is set.
 * @param props.mood Selects which mood-specific sprite trio is shown
 *                   via `BODY_BY_MOOD`. Falls back to `DEFAULT_MOOD`
 *                   (neutral) when unset.
 */
export default function Avatar({ currentUtterance, mood = DEFAULT_MOOD }: AvatarProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Three body sprites updated via DOM refs so we can drive opacity
  // swaps at PCM-chunk rate (~25Hz) without forcing a React re-render
  // every frame.
  const closedRef = useRef<HTMLImageElement | null>(null);
  const midRef = useRef<HTMLImageElement | null>(null);
  const wideRef = useRef<HTMLImageElement | null>(null);
  // Last mouth state actually committed to the DOM. Used to skip
  // redundant style writes when consecutive chunks resolve to the
  // same state — see applyAperture for the full reasoning.
  const lastStateRef = useRef<MouthState | null>(null);
  // Envelope state lives in a ref so the always-attached chunk listener
  // can read+write it without re-creating the closure on every render.
  const envelopeRef = useRef<number>(0);
  const lastAppliedRef = useRef<number>(0);
  // `isSpeaking` is the canonical predicate (audio_started has fired,
  // audio_ended hasn't). Re-evaluated on every render so a transition
  // in the utterance slot promptly flips the visual class + drives the
  // snap-closed effect below.
  const speaking = isSpeakingSelector({ currentUtterance });

  function applyAperture(aperture: number): void {
    const state = mouthStateFor(aperture);
    // Skip DOM writes when the mouth state hasn't changed since the
    // last call. Without this guard, every PCM chunk re-writes the
    // same opacity values to the same imgs (~25 writes/sec, often
    // <1ms apart inside a batch) and CSS `transition: opacity 80ms
    // linear` gets retargeted on every write — Chromium's compositor
    // never has a chance to paint the open-mouth states because each
    // transition is interrupted within microseconds. The visible
    // result is a frozen-closed mouth even though the apertureEvents
    // counter ticks at the syllable rate. By writing only on actual
    // state transitions, the transition runs to completion (the
    // 200ms inter-batch gap is plenty of time) and the open-mouth
    // sprite becomes visible on the rendered stream.
    if (lastStateRef.current === state) return;
    lastStateRef.current = state;
    // The closed body is the base layer — kept at opacity 1 so the
    // mid/wide overlays cross-fade ON TOP of it. If we faded closed
    // to 0 in lockstep with mid/wide rising to 1, mid-transition
    // both layers sit near 0.5 opacity and the page background shows
    // through — visible as a body-flicker on every mouth-state
    // change. Holding closed at full opacity makes those crossfades
    // additive (mouth-shape morph) instead of subtractive (full body
    // flash).
    if (closedRef.current) closedRef.current.style.opacity = "1";
    if (midRef.current) midRef.current.style.opacity = state === "mid" ? "1" : "0";
    if (wideRef.current) wideRef.current.style.opacity = state === "wide" ? "1" : "0";
  }

  // Chunk listener attaches once on mount and stays attached for the
  // component's lifetime. Previously the listener was conditioned on
  // `tts.speaking`, which created a race: when `speaking=true` is
  // driven by the first PCM chunk (the new noteChunk-first behaviour
  // in speakingClock), the very chunk that flipped the flag would
  // arrive before React processed the state change and attached the
  // listener — silently lost. With an always-attached listener, every
  // chunk drives the envelope, and the speaking-state effect below
  // only handles the mouth-snap-closed transition.
  //
  // On mount the effect ALSO:
  //   1. Drains `drainPcmReplayQueue()` and applies each missed chunk
  //      to the envelope. Avatar is `lazy()`-loaded by BroadcastShell,
  //      so the bus's message listener typically attaches before this
  //      effect fires; chunks decoded during that window are pushed to
  //      the replay queue but the live `pcmEvents.dispatchEvent` lands
  //      on no listener. Draining here recovers them.
  //   2. Sets `window.__pgBroadcastReady = true` so the streamer-bot
  //      driver's `page.waitForFunction` wakes up — confirming both
  //      this listener and the bus's listener are live before the
  //      runner starts speaking. Cleared on unmount so a navigation
  //      that tears down the React tree (hard `page.goto` fallback in
  //      softNavigate) re-arms the wait on the next mount.
  useEffect(() => {
    const stats = ensureStats();
    function processChunk(detail: PcmChunkDetail) {
      if (!detail || !detail.samples) return;
      const rms = rmsOf(detail.samples);
      const target = rmsToAperture(rms);
      const alpha = target > envelopeRef.current ? ATTACK_ALPHA : RELEASE_ALPHA;
      envelopeRef.current = envelopeRef.current + (target - envelopeRef.current) * alpha;
      stats.processed += 1;
      stats.lastRms = rms;
      stats.lastAperture = envelopeRef.current;
      stats.lastSampleCount = detail.samples.length;
      if (Math.abs(envelopeRef.current - lastAppliedRef.current) >= 0.05) {
        stats.apertureEvents += 1;
        lastAppliedRef.current = envelopeRef.current;
      }
      applyAperture(envelopeRef.current);
    }
    function handleChunk(ev: Event) {
      processChunk((ev as CustomEvent<PcmChunkDetail>).detail);
    }
    pcmEvents.addEventListener("chunk", handleChunk);
    // Backfill the cold-start window: any chunks decoded before this
    // listener attached are sitting in the replay queue. Feed them
    // through `processChunk` directly — no need to synthesize fake
    // CustomEvent envelopes; the per-chunk body is the same code path
    // either way.
    const replays = drainPcmReplayQueue();
    for (const detail of replays) processChunk(detail);
    // `__pgBroadcastReady` is intentionally one-shot: set to true on
    // mount and never cleared. React.StrictMode invokes the cleanup-
    // then-mount-again pattern in dev (apps/web/src/main.tsx wraps the
    // root in <StrictMode>); a clear-on-unmount would briefly flip the
    // flag to false even though the bus listener is still healthy,
    // and the runner's `awaitBroadcastReady` poll could sample during
    // that window and proceed prematurely. Production transient
    // remounts (e.g. AuthModal-driven body class churn — see
    // BroadcastShell.tsx body-class effect) would have the same
    // failure mode. The flag survives until full page reload, which
    // clears window globals as a side effect — exactly the lifecycle
    // the runner expects (hard `page.goto` fallback re-arms the wait
    // because the new document's globals start fresh).
    if (typeof window !== "undefined") {
      window.__pgBroadcastReady = true;
    }
    return () => {
      pcmEvents.removeEventListener("chunk", handleChunk);
    };
  }, []);

  // Snap to closed whenever the speaking flag goes false (end of
  // utterance) so a stale envelope tail doesn't leave the mouth open
  // between lines. We don't gate the chunk listener on `speaking`
  // (see comment above) so this is the only speaking-state handler.
  //
  // EFFECT-ORDERING NOTE: this effect MUST stay declared BEFORE the
  // anticipation effect below. React fires effects in declaration
  // order on cold mount; with `currentUtterance != null` and
  // `audioStartedAt === null` (the cold-start case), `speaking` is
  // false → this effect's `applyAperture(0)` runs first → then the
  // anticipation effect runs and overwrites with mid. Reverse the
  // order and the snap-closed wipes the anticipation pulse.
  //
  // The dep list intentionally also tracks `audioEndedAt` so the
  // synthesised end path (Piper crashed before any PCM, reducer
  // sets `audioStartedAt = audioEndedAt` in one step → `speaking`
  // goes false → false → no re-run via `[speaking]` alone) still
  // forces a close-down. Without this, an anticipation pulse that
  // landed before the synthesis would leave the mouth stuck on mid
  // until the next utterance.
  useEffect(() => {
    if (!speaking) {
      envelopeRef.current = 0;
      lastAppliedRef.current = 0;
      // Force the snap-closed write to land even if applyAperture's
      // dedup guard would skip it (e.g. last live state was already
      // "closed" because the envelope decayed naturally before
      // audio_ended fired).
      lastStateRef.current = null;
      applyAperture(0);
    }
  }, [speaking, currentUtterance?.audioEndedAt]);

  // Anticipatory phantom-syllable lead-in: drive a short synthetic
  // mouth animation the moment a NEW utterance starts (before any
  // PCM chunk has arrived) so the visual motion precedes the audio
  // rather than lagging it.
  //
  // The earlier version of this effect seeded the envelope to a
  // single static value (0.20 → mid) and held it until real PCM took
  // over. That fixed the timing of the mouth OPENING — viewers no
  // longer saw "subtitle → voice → ~80ms gap → mouth opens" — but it
  // didn't fix the timing of the mouth ANIMATION: the static mid
  // pose read as "mouth ajar, holding still", and the actual
  // closed↔mid↔wide motion only kicked in when the first real chunk
  // arrived ~80–150ms after T0. The phantom-syllable cycle below
  // produces visible state changes during that window — viewers see
  // one fake syllable of motion instead of a held pose.
  //
  // The audio-path / visual-path latency split is real: `aplay` →
  // Pulse → ffmpeg → RTMP captures audio at sub-30ms latency, while
  // first-PCM → chunkThrottle → pcmBatcher → Socket.IO → reducer →
  // DOM paint adds 50–100ms before the mouth visibly responds. The
  // cycle below covers that gap with synthetic motion that the chunk
  // listener overwrites within 2–3 real chunks once PCM lands.
  //
  // Keyed on `currentUtterance.id` so back-to-back utterances each
  // get a fresh phantom syllable. The cleanup function tears down
  // the interval, which fires both when the effect re-runs (because
  // `audioStartedAt` flipped non-null → real PCM is now driving) and
  // on unmount.
  const lastUtteranceIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = currentUtterance?.id ?? null;
    if (!id) return;
    // Only fire the phantom syllable when audio has NOT yet started
    // (`audioStartedAt === null`). If we receive an utterance that
    // already has audio in flight (e.g. mid-utterance remount, replay
    // from a persisted snapshot, or a test fixture that pre-sets
    // audioStartedAt), the lead-in is meaningless — the PCM-driven
    // envelope is the source of truth and anything we overwrite would
    // just be a brief flash before the next chunk re-asserts state.
    if (currentUtterance?.audioStartedAt != null) return;
    // Treat a stale id WITHOUT audio (already pulsed) as a no-op so
    // we don't restart the cycle on every unrelated re-render. The
    // same id transitioning audioStartedAt null → non-null is handled
    // by the cleanup-on-effect-rerun path: this branch returns early
    // for that case anyway (audioStartedAt != null guard above).
    if (id === lastUtteranceIdRef.current) return;
    lastUtteranceIdRef.current = id;

    // Drive the phantom syllable. The first apply is synchronous (so
    // a test that mounts and immediately reads opacity sees the seed
    // before any timer has ticked); subsequent applies fire on the
    // interval until cleanup.
    let i = 0;
    function tickPhantom(): void {
      const v = PHANTOM_PATTERN[i % PHANTOM_PATTERN.length];
      envelopeRef.current = v;
      // Mirror lastAppliedRef onto the envelope value so the
      // apertureEvents diag counter doesn't tick on pseudo-
      // transitions that are just the phantom seed (the counter is
      // meant to track real envelope dynamics, not bootstrap).
      lastAppliedRef.current = v;
      applyAperture(v);
      i += 1;
    }
    tickPhantom();
    const interval = setInterval(tickPhantom, PHANTOM_TICK_MS);
    // Hard cap: if `audioStartedAt` never flips (Piper stall or
    // dropped audio_started envelope), stop the loop after
    // PHANTOM_MAX_MS so the mouth doesn't churn unboundedly. The
    // most recent phantom value remains in place; the snap-closed
    // effect (driven by audioEndedAt) handles the eventual cleanup.
    const cap = setTimeout(() => clearInterval(interval), PHANTOM_MAX_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(cap);
      // Clear the id guard so a future remount of the SAME utterance
      // can re-arm the cycle. The most common path here is React 18
      // StrictMode in dev, which mount→cleanup→mount synchronously: if
      // we left the ref pinned, the second mount's id-equality guard
      // would short-circuit and skip the timer (the synchronous seed
      // still lands, but the cycle never starts). Production code
      // hits this on dep changes only, where the early-return at
      // `audioStartedAt != null` is what stops a re-arm — not the
      // id guard — so resetting here is safe in either mode.
      lastUtteranceIdRef.current = null;
    };
  }, [currentUtterance?.id, currentUtterance?.audioStartedAt]);

  return (
    <div
      ref={rootRef}
      className={speaking ? "broadcast-avatar is-speaking" : "broadcast-avatar"}
      data-testid="broadcast-avatar"
      data-speaking={speaking ? "true" : "false"}
      data-mood={mood}
      aria-hidden="true"
    >
      <img
        ref={closedRef}
        className="broadcast-avatar-frame broadcast-avatar-frame-body"
        data-testid="broadcast-avatar-frame-body"
        src={BODY_BY_MOOD[mood].closed}
        alt=""
        draggable={false}
        style={{ opacity: 1 }}
      />
      <img
        ref={midRef}
        className="broadcast-avatar-frame broadcast-avatar-frame-mid"
        data-testid="broadcast-avatar-frame-mid"
        src={BODY_BY_MOOD[mood].mid}
        alt=""
        draggable={false}
        style={{ opacity: 0 }}
      />
      <img
        ref={wideRef}
        className="broadcast-avatar-frame broadcast-avatar-frame-wide"
        data-testid="broadcast-avatar-frame-wide"
        src={BODY_BY_MOOD[mood].wide}
        alt=""
        draggable={false}
        style={{ opacity: 0 }}
      />
    </div>
  );
}

export const __avatarInternals = {
  rmsOf,
  rmsToAperture,
  mouthStateFor,
  ATTACK_ALPHA,
  RELEASE_ALPHA,
};
