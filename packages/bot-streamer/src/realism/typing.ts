/**
 * Keystroke generator: turns a target string into a sequence of typing
 * events that look like a human is typing on a keyboard.
 *
 * The output describes events, not actual keypresses — the Playwright
 * driver consumes them to call `page.keyboard.type` with appropriate
 * delays, and `page.keyboard.press('Backspace')` for typo corrections.
 */
import { gaussian, type RngOptions } from "./timing";

export type TypingEventKind = "char" | "backspace";

export interface TypingEvent {
  kind: TypingEventKind;
  /** The character to type; undefined for backspace events. */
  char?: string;
  /** Delay before this event fires, in milliseconds. */
  delayMs: number;
}

export interface TypingPlanOptions extends RngOptions {
  /** Words-per-minute centre for the rhythm distribution. Default 85. */
  wpm?: number;
  /** Probability of a typo per character. Default 0.03. */
  typoRate?: number;
}

const DEFAULT_RNG = Math.random;
const DEFAULT_WPM = 85;
const DEFAULT_TYPO_RATE = 0.03;
// Average characters per word for English typing-speed conversion. WPM
// is conventionally measured assuming 5 characters per word.
const CHARS_PER_WORD = 5;
const PUNCTUATION_PAUSE = new Set([",", ".", "!", "?", ";", ":"]);

// Adjacent-key map for QWERTY typo simulation. Only lowercase is wired
// because typo characters are almost always rendered lowercase by typists
// hitting the wrong physical key.
const QWERTY_ADJACENT: Record<string, string> = {
  q: "wa", w: "qse", e: "wrd", r: "etf", t: "ryg", y: "tuh",
  u: "yij", i: "uok", o: "ipl", p: "o",
  a: "qwsz", s: "awedxz", d: "serfcx", f: "drtgvc", g: "ftyhbv", h: "gyujnb",
  j: "huikmn", k: "jiolm", l: "kop",
  z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk",
};

function typoChar(c: string, rng: () => number): string | null {
  const lower = c.toLowerCase();
  const neighbours = QWERTY_ADJACENT[lower];
  if (!neighbours) return null;
  const pick = neighbours[Math.floor(rng() * neighbours.length)];
  return c === c.toUpperCase() ? pick.toUpperCase() : pick;
}

/**
 * Plan a typing sequence for `text` with humanlike per-keystroke timing
 * and occasional typo+backspace corrections.
 *
 * @param text Final string to be typed.
 * @param opts See {@link TypingPlanOptions}.
 * @returns Sequence of events the driver should replay in order.
 */
export function planTypingEvents(text: string, opts: TypingPlanOptions = {}): TypingEvent[] {
  const rng = opts.rng ?? DEFAULT_RNG;
  const wpm = opts.wpm ?? DEFAULT_WPM;
  const typoRate = opts.typoRate ?? DEFAULT_TYPO_RATE;

  // Mean keystroke gap (ms) for the requested WPM. WPM measures typed
  // characters per minute / chars-per-word; invert to ms-per-keystroke.
  const meanKeystrokeMs = 60_000 / (wpm * CHARS_PER_WORD);
  const stdKeystrokeMs = meanKeystrokeMs * 0.35;

  const events: TypingEvent[] = [];
  // Carries the punctuation tail-pause from the previous char into the
  // pre-delay of the next char. This is cleaner than emitting a synthetic
  // empty-char event because consumers can replay the stream verbatim.
  let pendingExtraDelay = 0;

  for (const c of text) {
    const baseDelay = Math.max(20, Math.round(gaussian(meanKeystrokeMs, stdKeystrokeMs, rng)));
    const firstDelay = baseDelay + pendingExtraDelay;
    pendingExtraDelay = 0;

    // Decide whether this character will be a typo. Apostrophes, spaces,
    // and digits aren't represented in the QWERTY adjacency map, so
    // typoChar will return null and we'll skip the typo path.
    const wantsTypo = rng() < typoRate;
    const wrong = wantsTypo ? typoChar(c, rng) : null;
    if (wrong && wrong !== c) {
      events.push({ kind: "char", char: wrong, delayMs: firstDelay });
      // Brief pause realising the mistake, then backspace.
      events.push({ kind: "backspace", delayMs: 90 + Math.round(rng() * 90) });
      // Correction keystroke a touch slower than baseline.
      events.push({ kind: "char", char: c, delayMs: Math.round(baseDelay * 1.15) });
    } else {
      events.push({ kind: "char", char: c, delayMs: firstDelay });
    }

    if (PUNCTUATION_PAUSE.has(c)) {
      pendingExtraDelay = 200 + Math.round(rng() * 200);
    }
  }
  return events;
}
