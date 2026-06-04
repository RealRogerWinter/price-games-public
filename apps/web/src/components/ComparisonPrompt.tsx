import { useState } from "react";

/**
 * Direction the round is asking about. The known values come from the server
 * payload (`RoundStartPayload.question`); the `(string & {})` tail keeps the
 * prop assignable from a loosely-typed string field while still surfacing
 * autocomplete for the two real values.
 */
export type ComparisonQuestion = "most-expensive" | "least-expensive" | (string & {});

interface ComparisonPromptProps {
  /**
   * Server-issued direction for this round. Anything other than
   * "least-expensive" is treated as "most-expensive" so callers don't have to
   * normalise.
   */
  question: ComparisonQuestion;
  /**
   * Identifier that changes once per round (e.g. round number). The hero
   * element is keyed off this so the CSS entry animation re-fires every
   * round, not just on direction flips. Callers should pass a value that is
   * stable within a round and unique across consecutive rounds.
   */
  roundKey: string | number;
}

/**
 * Renders the comparison-mode question banner: a giant directional word
 * (MORE / LESS) with a matching glyph, framed by helper text. The directional
 * word is the most prominent thing on the screen during a round so players
 * cannot miss when the direction flips.
 *
 * Sets `data-question` for direction-scoped styling and `data-flipped="true"`
 * on the wrapper for the one render where the question changes from the
 * previous render — used by CSS to layer an extra emphasis animation only on
 * flips.
 *
 * Includes an aria-live region that re-announces the direction whenever it
 * changes between rounds (same-direction rounds are intentionally not
 * re-announced to avoid screen-reader spam).
 */
export default function ComparisonPrompt({ question, roundKey }: ComparisonPromptProps) {
  const isLess = question === "least-expensive";
  const word = isLess ? "LESS" : "MORE";
  const glyph = isLess ? "▼" : "▲";

  // Track the previous question via guarded setState-during-render rather
  // than a ref mutated during render. Two reasons:
  //   1. React 18 StrictMode invokes render twice in dev — a ref mutation
  //      during render would be observed twice and zero out the flipped
  //      flag on the second invocation. The `if` guard below makes the
  //      second invocation a no-op, so the snapshot stays consistent.
  //   2. State updates are committed synchronously when triggered during
  //      render, so `flipped` is correct on the first commit after a flip
  //      (no extra frame of delay).
  const [snapshot, setSnapshot] = useState<{ prev: string | null; current: string }>({
    prev: null,
    current: question,
  });
  if (snapshot.current !== question) {
    setSnapshot({ prev: snapshot.current, current: question });
  }
  const flipped = snapshot.prev !== null && snapshot.prev !== snapshot.current;

  return (
    <div
      className="comparison-prompt"
      data-question={question}
      data-flipped={flipped ? "true" : undefined}
    >
      <p className="comparison-prompt__helper">Which product is</p>
      <div key={roundKey} className="comparison-prompt__hero">
        <span className="comparison-prompt__glyph" data-testid="comparison-prompt-glyph" aria-hidden>
          {glyph}
        </span>
        <span className="comparison-prompt__word">{word}</span>
      </div>
      <p className="comparison-prompt__suffix">expensive?</p>
      <span className="visually-hidden" aria-live="polite">
        Find the {word.toLowerCase()} expensive product.
      </span>
    </div>
  );
}
