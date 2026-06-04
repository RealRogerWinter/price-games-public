import { useEffect, useState } from "react";
import {
  subtitleVisible,
  SUBTITLE_MIN_VISIBLE_MS,
  type CurrentUtterance,
} from "../state/overlayBus";

interface SubtitlesProps {
  /**
   * Active utterance from the bus's `currentUtterance` slot, or null
   * when nothing is being spoken. PR 3 swap: replaces the legacy
   * `subtitle` prop (driven by an estimated duration) with the
   * single-source-of-truth slot reduced from `tts.utterance.*`
   * envelopes — visibility is now anchored to the REAL audio-end
   * signal (`audioEndedAt`), not to a text-length guess.
   */
  currentUtterance: CurrentUtterance | null;
}

/**
 * Cartoon speech-bubble for the bot's spoken narration.
 * **Mandatory for accessibility AND comprehension** — Twitch silences
 * audio by default, and a substantial fraction of viewers will never
 * hear the TTS. Without subtitles the bot's commentary is invisible
 * to those viewers.
 *
 * Visual: cream-paper bubble with thick ink outline, anchored to the
 * right of the streamer-bot avatar at mouth height. A leftward tail
 * points back toward Pricey's mouth so viewers read it as the avatar
 * actually saying the line.
 *
 * PR 3 of the lipsync rebuild: hides on `audioEndedAt` (driven by
 * `aplay.exit` in the runner — the moment the speaker buffer drains).
 * A `SUBTITLE_MIN_VISIBLE_MS` floor keeps short utterances readable
 * even if their audio ends faster. The floor is anchored to
 * `startedAt`, not `audioEndedAt`, so a long subtitle that ends
 * naturally doesn't get an extra MIN tail glued onto it.
 *
 * @param props.currentUtterance Latest utterance lifecycle slot, or null.
 */
export default function Subtitles({ currentUtterance }: SubtitlesProps) {
  // Local copy of currentUtterance kept around so the bubble doesn't
  // disappear the instant a new currentUtterance arrives null between
  // utterances — `subtitleVisible(...)` consults the floor.
  const [shownUtterance, setShownUtterance] = useState<CurrentUtterance | null>(currentUtterance);

  useEffect(() => {
    if (!currentUtterance) {
      // No active utterance — hide the bubble immediately (the floor
      // only applies AFTER a real start).
      setShownUtterance(null);
      return;
    }
    setShownUtterance(currentUtterance);
    // Once audio_ended fires, schedule a re-render at the moment the
    // floor expires so the bubble can hide itself. Without this
    // setTimeout the component would remain rendered until the next
    // currentUtterance change (e.g. the next utterance arrives).
    if (currentUtterance.audioEndedAt == null) return;
    const elapsed = Date.now() - currentUtterance.startedAt;
    const remaining = Math.max(0, SUBTITLE_MIN_VISIBLE_MS - elapsed);
    const id = setTimeout(() => {
      setShownUtterance((cur) => (cur?.id === currentUtterance.id ? null : cur));
    }, remaining);
    return () => clearTimeout(id);
  }, [currentUtterance]);

  if (!shownUtterance) return null;
  // `subtitleVisible` is the canonical predicate — re-evaluate against
  // the locally-shown utterance so the floor logic is centralised in
  // the bus module (one place to tune the SUBTITLE_MIN_VISIBLE_MS
  // constant, one selector for tests to assert against).
  if (!subtitleVisible({ currentUtterance: shownUtterance })) return null;

  return (
    <div
      className="broadcast-subtitles"
      data-testid="broadcast-subtitles"
      role="status"
      aria-live="polite"
    >
      <span className="broadcast-subtitles-text">{shownUtterance.text}</span>
    </div>
  );
}
