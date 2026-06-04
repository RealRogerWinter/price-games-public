import { describe, it, expect } from "vitest";
import { planTypingEvents } from "../src/realism/typing";
import { seeded } from "./_rng";

function reconstruct(events: ReturnType<typeof planTypingEvents>): string {
  // Replay the event stream the way the Playwright driver would: chars
  // append, backspaces remove the last appended char.
  let buf = "";
  for (const ev of events) {
    if (ev.kind === "backspace") {
      buf = buf.slice(0, -1);
    } else if (ev.char) {
      buf += ev.char;
    }
  }
  return buf;
}

describe("planTypingEvents", () => {
  it("eventually produces the target string when typo corrections are applied", () => {
    const text = "hello world";
    const events = planTypingEvents(text, { rng: seeded(1), typoRate: 0.5 });
    expect(reconstruct(events)).toBe(text);
  });

  it("contains a backspace event when a typo fires", () => {
    // High typo rate guarantees at least one backspace in this string.
    const events = planTypingEvents("the quick brown fox jumps", {
      rng: seeded(2),
      typoRate: 0.9,
    });
    const backspaces = events.filter((e) => e.kind === "backspace").length;
    expect(backspaces).toBeGreaterThan(0);
  });

  it("emits zero typo events when typoRate is 0", () => {
    const events = planTypingEvents("hello", { rng: seeded(3), typoRate: 0 });
    expect(events.filter((e) => e.kind === "backspace")).toHaveLength(0);
    expect(reconstruct(events)).toBe("hello");
  });

  it("adds a 200-400ms pause after punctuation, folded into the next char's delay", () => {
    const events = planTypingEvents("hi.bye", { rng: seeded(4), typoRate: 0 });
    // The character right after '.' inherits an extra 200-400ms on top of
    // its baseline keystroke delay.
    const dotIdx = events.findIndex((e) => e.char === ".");
    const nextEv = events[dotIdx + 1];
    expect(nextEv.char).toBe("b");
    // baseline keystroke max is around ~140ms at default WPM; the
    // punctuation tail pushes the next-char delay decisively above 200.
    expect(nextEv.delayMs).toBeGreaterThanOrEqual(220);
    expect(nextEv.delayMs).toBeLessThanOrEqual(600);
  });

  it("respects the requested WPM in expected order of magnitude", () => {
    const slow = planTypingEvents("aaaaaaaaaa", { rng: seeded(5), wpm: 30, typoRate: 0 });
    const fast = planTypingEvents("aaaaaaaaaa", { rng: seeded(5), wpm: 120, typoRate: 0 });
    const slowMean = slow.reduce((a, b) => a + b.delayMs, 0) / slow.length;
    const fastMean = fast.reduce((a, b) => a + b.delayMs, 0) / fast.length;
    expect(fastMean).toBeLessThan(slowMean);
  });
});
