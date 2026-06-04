/**
 * Render-shape tests for the broadcast panels. Each panel is purely
 * presentational so tests focus on:
 *   - Renders without crashing on initial / empty state.
 *   - Reflects prop changes (visible text, classes, count).
 *   - Empty/idle placeholder shows when no data is available.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import {
  pcmEvents,
  dispatchOverlayEvent,
  useOverlayState,
  __resetReplayBuffersForTests,
  type PcmChunkDetail,
} from "../state/overlayBus";
import HeaderBar from "./HeaderBar";
import GiveawayBanner from "./GiveawayBanner";
import RecentRounds from "./RecentRounds";
import ChatOverlay from "./ChatOverlay";
import MusicTicker from "./MusicTicker";
import Visualizer from "./Visualizer";
import Subtitles from "./Subtitles";
import LobbyRadar from "./LobbyRadar";
import Avatar from "./Avatar";
import ThoughtFeed from "./ThoughtFeed";
import type { ThoughtEntry } from "../state/overlayBus";

function thought(overrides: Partial<ThoughtEntry> = {}): ThoughtEntry {
  return {
    id: overrides.id ?? `t-${Math.random()}`,
    text: overrides.text ?? "thinking…",
    intent: overrides.intent ?? "ambient",
    mood: overrides.mood ?? "neutral",
    at: overrides.at ?? Date.now(),
  };
}
import type { BotStats, ChatMessage, RecentRound } from "../state/overlayBus";

describe("HeaderBar", () => {
  it("renders the logo image, the 24/7 tag, and the play-at CTA", () => {
    render(<HeaderBar />);
    const header = screen.getByTestId("broadcast-header");
    expect(header).toBeTruthy();
    const logo = header.querySelector("img.broadcast-header-logo-img") as HTMLImageElement | null;
    expect(logo).toBeTruthy();
    expect(logo?.alt).toMatch(/price\.games/i);
    expect(screen.getByText(/24\/7 BOT STREAM/i)).toBeTruthy();
    expect(screen.getByText(/Play at/i)).toBeTruthy();
    expect(screen.getByText(/https:\/\/price\.games/i)).toBeTruthy();
  });

  it("does not render a lifecycle-phase chip — viewers don't need one", () => {
    render(<HeaderBar />);
    const header = screen.getByTestId("broadcast-header");
    expect(header.querySelector(".broadcast-header-phase")).toBeNull();
    expect(header.querySelector(".broadcast-header-status")).toBeNull();
  });
});

describe("GiveawayBanner", () => {
  it("renders the treasure-chest icon, the prize tag, and the price.games CTA", () => {
    render(<GiveawayBanner />);
    const banner = screen.getByTestId("broadcast-giveaway");
    expect(banner).toBeTruthy();
    const icon = banner.querySelector("img.broadcast-giveaway-icon") as HTMLImageElement | null;
    expect(icon).toBeTruthy();
    // The icon is decorative — the descriptive copy is the headline.
    expect(icon?.alt).toBe("");
    expect(banner.textContent).toMatch(/\$50/);
    expect(banner.textContent?.toLowerCase()).toContain("price.games");
    // The aria-label carries the full pitch for assistive tech viewers.
    expect(banner.getAttribute("aria-label")?.toLowerCase()).toContain("$50");
    expect(banner.getAttribute("aria-label")?.toLowerCase()).toContain("amazon");
  });
});

describe("RecentRounds", () => {
  it("shows empty placeholder when no rounds played", () => {
    render(<RecentRounds rounds={[]} />);
    expect(screen.getByText(/no rounds played yet/i)).toBeTruthy();
  });

  it("renders a row per round with outcome class", () => {
    const rounds: RecentRound[] = [
      { mode: "classic", outcome: "correct", points: 800, at: 1000 },
      { mode: "higher-lower", outcome: "incorrect", points: 0, at: 999 },
    ];
    render(<RecentRounds rounds={rounds} />);
    const items = screen.getAllByTestId("recent-round-item");
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-outcome")).toBe("correct");
    expect(items[1].getAttribute("data-outcome")).toBe("incorrect");
    expect(items[0].textContent).toContain("Classic");
    expect(items[0].textContent).toContain("+800");
  });
});

describe("ChatOverlay", () => {
  it("shows empty placeholder when no messages", () => {
    render(<ChatOverlay messages={[]} />);
    expect(screen.getByText(/no messages yet/i)).toBeTruthy();
  });

  it("renders one row per message with platform badge", () => {
    const messages: ChatMessage[] = [
      { id: "1", platform: "twitch", user: "alice", text: "hi bot", at: 1 },
      { id: "2", platform: "youtube", user: "bob", text: "GG", at: 2 },
    ];
    render(<ChatOverlay messages={messages} />);
    const rows = screen.getAllByTestId("chat-message");
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-platform")).toBe("twitch");
    expect(rows[0].textContent).toContain("alice");
    expect(rows[0].textContent).toContain("hi bot");
    expect(rows[1].getAttribute("data-platform")).toBe("youtube");
  });

  it("pins the message row font-size at 17px so chat stays legible from a streamed-frame distance", () => {
    // Regression guard for the UI-polish bump from 13→17px. jsdom doesn't
    // load Vite-imported stylesheets into computed style, so this asserts
    // against the CSS file's source text instead — a future shrink would
    // change the literal and trip this test even if a refactor moved
    // the rule under a different surrounding selector. Resolved relative
    // to vitest's cwd (the `apps/web/` package, set by the
    // `apps/web/vitest.config.ts` location).
    const cssPath = resolve(process.cwd(), "src/broadcast/styles/broadcast.css");
    const css = readFileSync(cssPath, "utf8");
    const block = /\.broadcast-chat-message\s*\{[^}]*\}/m.exec(css);
    expect(block, ".broadcast-chat-message rule must exist").toBeTruthy();
    expect(block![0]).toMatch(/font-size:\s*17px/);
  });

  it("auto-scrolls to the newest message even when the array length is at the cap", () => {
    // Regression: a previous version depended on `[messages.length]`. Once
    // the bus's CHAT_HISTORY_LIMIT (30) cap is reached, every new message
    // slices an old one off so the length plateaus at 30 and the effect
    // stopped firing — new messages rendered but the panel never scrolled.
    // Now we depend on the latest message id, which changes every push.
    const initial: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      platform: "twitch",
      user: "u",
      text: `msg ${i}`,
      at: i,
    }));
    const { rerender } = render(<ChatOverlay messages={initial} />);
    const list = screen.getByTestId("broadcast-chat").querySelector("ol") as HTMLOListElement;

    // Stub the geometry so the auto-pin condition's distance-from-bottom
    // check passes (jsdom reports zeroes for layout properties).
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 200 });
    list.scrollTop = 800;

    // New message slices the oldest off — array length still 30.
    const next: ChatMessage[] = [...initial.slice(1), {
      id: "m30",
      platform: "twitch",
      user: "u",
      text: "msg 30",
      at: 30,
    }];
    rerender(<ChatOverlay messages={next} />);
    expect(list.scrollTop).toBe(1000);
  });
});

describe("MusicTicker", () => {
  it("shows idle text when no track info", () => {
    render(<MusicTicker music={null} />);
    expect(screen.getByText(/music will start when the streamer is up/i)).toBeTruthy();
  });

  it("shows title and artist when track info is present", () => {
    render(<MusicTicker music={{ title: "Coffee Shop", artist: "Lofi Girl" }} />);
    const node = screen.getByTestId("music-now");
    expect(node.textContent).toContain("Coffee Shop");
    expect(node.textContent).toContain("Lofi Girl");
  });
});

describe("Visualizer", () => {
  it("renders a canvas marked aria-hidden", () => {
    render(<Visualizer />);
    const canvas = screen.getByTestId("broadcast-visualizer");
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Subtitles", () => {
  it("renders nothing when currentUtterance is null", () => {
    const { container } = render(<Subtitles currentUtterance={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the subtitle text with role=status + aria-live=polite for screen readers", () => {
    const cu = {
      id: "u-1",
      text: "Going slightly over.",
      intent: "round_start",
      mood: "neutral" as const,
      estimatedDurationMs: 1800,
      startedAt: Date.now(),
      audioStartedAt: null,
      audioEndedAt: null,
    };
    render(<Subtitles currentUtterance={cu} />);
    const node = screen.getByTestId("broadcast-subtitles");
    expect(node.textContent).toContain("Going slightly over.");
    expect(node.getAttribute("role")).toBe("status");
    expect(node.getAttribute("aria-live")).toBe("polite");
  });

  it("hides the bubble after SUBTITLE_MIN_VISIBLE_MS expires post-audio_ended", async () => {
    // Pin the floor-timer behaviour: when the prop transitions to
    // include audioEndedAt, the component schedules a setTimeout
    // for `SUBTITLE_MIN_VISIBLE_MS - elapsed` ms and clears itself
    // when it fires. Without this test a future refactor that loses
    // the cleanup branch would silently leave subtitles visible
    // forever.
    vi.useFakeTimers();
    const startedAt = 1000;
    const baseUtterance = {
      id: "u-floor",
      text: "Quick ack.",
      intent: "manual",
      mood: "neutral" as const,
      estimatedDurationMs: 500,
      startedAt,
      audioStartedAt: 1100,
      audioEndedAt: null,
    };
    vi.setSystemTime(startedAt + 100);
    const { rerender } = render(<Subtitles currentUtterance={baseUtterance} />);
    expect(screen.queryByTestId("broadcast-subtitles")).not.toBeNull();

    // Audio ends fast (200ms in). Re-render with audioEndedAt set.
    vi.setSystemTime(startedAt + 200);
    rerender(<Subtitles currentUtterance={{ ...baseUtterance, audioEndedAt: 1200 }} />);
    // Bubble still visible — inside the floor.
    expect(screen.queryByTestId("broadcast-subtitles")).not.toBeNull();

    // Advance past the floor; the cleanup-setTimeout fires and the
    // local state clears.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId("broadcast-subtitles")).toBeNull();
    vi.useRealTimers();
  });

  it("re-renders cleanly when utterance B replaces utterance A mid-floor (cleanup cancels A's pending timer)", async () => {
    // Belt-and-braces: React's useEffect cleanup synchronously calls
    // clearTimeout on A's pending floor-expiry timer, so when B's
    // prop transition fires, A's timer is cancelled before it ever
    // gets a chance to clear B's slot. This test pins that invariant
    // — a future refactor that drops the cleanup return would break
    // this case loudly.
    vi.useFakeTimers();
    const utteranceA = {
      id: "u-A",
      text: "first line",
      intent: "manual",
      mood: "neutral" as const,
      estimatedDurationMs: 500,
      startedAt: 1000,
      audioStartedAt: 1050,
      audioEndedAt: 1200,
    };
    vi.setSystemTime(1300);
    const { rerender } = render(<Subtitles currentUtterance={utteranceA} />);
    expect(screen.getByTestId("broadcast-subtitles").textContent).toContain("first line");

    const utteranceB = {
      id: "u-B",
      text: "second line",
      intent: "manual",
      mood: "neutral" as const,
      estimatedDurationMs: 500,
      startedAt: 2000,
      audioStartedAt: 2050,
      audioEndedAt: null,
    };
    vi.setSystemTime(2100);
    rerender(<Subtitles currentUtterance={utteranceB} />);
    expect(screen.getByTestId("broadcast-subtitles").textContent).toContain("second line");

    // Even though we advance past A's would-be floor, B stays visible
    // because A's timer was cleared by React's cleanup.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId("broadcast-subtitles")?.textContent).toContain("second line");
    vi.useRealTimers();
  });
});

describe("Avatar (Path B — full-body sprite trio per mood)", () => {
  // Reset replay queues + window-global counters between every Avatar
  // test. Without this, the integration suite below leaves chunks in
  // pcmReplayQueue and bumps __pgPcmStats — Avatar's mount drains the
  // replay queue on every render, so leftover chunks would silently
  // apply to envelope assertions in this suite. Hoisted here (rather
  // than left to the file's natural test order) so vitest --shard,
  // sequence.shuffle, or any future describe.concurrent migration
  // can't silently change behaviour.
  beforeEach(() => {
    __resetReplayBuffersForTests();
  });

  // PR 3 prop swap: Avatar takes a `currentUtterance` slot instead
  // of the legacy `TtsState`. `idleUtterance` = no active utterance
  // (Avatar renders mouth-closed); `speakingUtterance` = audio
  // started, not ended (Avatar renders is-speaking + drives the
  // full-body sprite trio from PCM chunks). Keeping the same
  // `idleTts` / `speakingTts` variable names so the test bodies
  // don't churn.
  const idleTts = null;
  const speakingUtterance = {
    id: "u-test",
    text: "speaking",
    intent: "round_start",
    mood: "neutral" as const,
    estimatedDurationMs: 2000,
    startedAt: Date.now(),
    audioStartedAt: Date.now(),
    audioEndedAt: null,
  };
  const speakingTts = speakingUtterance;

  it("renders closed + mid + wide sprite images at all times — opacity picks the visible one", () => {
    render(<Avatar currentUtterance={idleTts} />);
    expect(screen.getByTestId("broadcast-avatar")).toBeTruthy();
    expect(screen.getByTestId("broadcast-avatar-frame-body")).toBeTruthy();
    expect(screen.getByTestId("broadcast-avatar-frame-mid")).toBeTruthy();
    expect(screen.getByTestId("broadcast-avatar-frame-wide")).toBeTruthy();
  });

  it("not speaking → mid/wide hidden, closed body visible at opacity 1", () => {
    render(<Avatar currentUtterance={idleTts} mood="neutral" />);
    const closed = screen.getByTestId("broadcast-avatar-frame-body") as HTMLElement;
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    expect(closed.style.opacity).toBe("1");
    expect(mid.style.opacity).toBe("0");
    expect(wide.style.opacity).toBe("0");
    expect(screen.getByTestId("broadcast-avatar").getAttribute("data-speaking")).toBe("false");
  });

  it("flips to is-speaking when tts.speaking=true and starts with mid/wide hidden, closed visible", () => {
    render(<Avatar currentUtterance={speakingTts} />);
    const root = screen.getByTestId("broadcast-avatar");
    expect(root.classList.contains("is-speaking")).toBe(true);
    expect(root.getAttribute("data-speaking")).toBe("true");
    const closed = screen.getByTestId("broadcast-avatar-frame-body") as HTMLElement;
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    expect(closed.style.opacity).toBe("1");
    expect(mid.style.opacity).toBe("0");
    expect(wide.style.opacity).toBe("0");
  });

  it("reflects all eight mood values on data-mood (default neutral)", () => {
    const { rerender } = render(<Avatar currentUtterance={idleTts} />);
    expect(screen.getByTestId("broadcast-avatar").getAttribute("data-mood")).toBe("neutral");
    for (const mood of ["happy", "confident", "elated", "focused", "tilted", "frustrated", "despondent"] as const) {
      rerender(<Avatar currentUtterance={idleTts} mood={mood} />);
      expect(screen.getByTestId("broadcast-avatar").getAttribute("data-mood")).toBe(mood);
    }
  });

  it("body sprite swaps when mood changes (PR 5: dedicated body per mood)", () => {
    // Vite's image imports stamp deterministic hashes into the asset
    // URLs (`/<repo>/dist-asset-<hash>.webp` or similar), so we can't
    // assert a literal path — just that the body's `src` differs
    // across moods. A shared `src` for two distinct moods would mean
    // BODY_BY_MOOD lost a row.
    const seen = new Map<string, string>();
    const { rerender } = render(<Avatar currentUtterance={idleTts} mood="neutral" />);
    for (const mood of ["neutral", "happy", "confident", "elated", "focused", "tilted", "frustrated", "despondent"] as const) {
      rerender(<Avatar currentUtterance={idleTts} mood={mood} />);
      const src = (screen.getByTestId("broadcast-avatar-frame-body") as HTMLImageElement).src;
      const prev = [...seen.entries()].find(([, s]) => s === src);
      expect(
        prev?.[0],
        `mood "${mood}" shares its body sprite src with mood "${prev?.[0] ?? ""}" — BODY_BY_MOOD probably lost a row`,
      ).toBeUndefined();
      seen.set(mood, src);
    }
    expect(seen.size).toBe(8);
  });

  it("mood trio uniqueness — closed, mid, wide srcs differ within every mood", () => {
    // Catches a copy-paste in BODY_BY_MOOD that points e.g.
    // `confident.wide` at the mid sprite — the trio would render a
    // mood with no visible difference between mid and wide states,
    // halving the perceived lipsync animation.
    const { rerender } = render(<Avatar currentUtterance={idleTts} mood="neutral" />);
    for (const mood of ["neutral", "happy", "confident", "elated", "focused", "tilted", "frustrated", "despondent"] as const) {
      rerender(<Avatar currentUtterance={idleTts} mood={mood} />);
      const closedSrc = (screen.getByTestId("broadcast-avatar-frame-body") as HTMLImageElement).src;
      const midSrc = (screen.getByTestId("broadcast-avatar-frame-mid") as HTMLImageElement).src;
      const wideSrc = (screen.getByTestId("broadcast-avatar-frame-wide") as HTMLImageElement).src;
      expect(closedSrc, `mood "${mood}": closed and mid sprites are identical`).not.toBe(midSrc);
      expect(closedSrc, `mood "${mood}": closed and wide sprites are identical`).not.toBe(wideSrc);
      expect(midSrc, `mood "${mood}": mid and wide sprites are identical`).not.toBe(wideSrc);
    }
  });

  it("is aria-hidden — viewers see it; screen readers ignore the decorative sprite", () => {
    render(<Avatar currentUtterance={idleTts} />);
    expect(screen.getByTestId("broadcast-avatar").getAttribute("aria-hidden")).toBe("true");
  });

  it("speech-like chunks during speaking lift the wide sprite above 0 (envelope crosses wide threshold)", async () => {
    render(<Avatar currentUtterance={speakingTts} />);
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    expect(wide.style.opacity).toBe("0");
    // Loud broadband chunk — RMS ~0.13 in normalised space; with the
    // avatar's gain=9 the target aperture saturates at 1.0 and the
    // envelope follower drives the state machine into `wide` after
    // a couple of attack chunks.
    const samples = makeLoudVowelChunk(1024, 22050);
    await act(async () => {
      for (let i = 0; i < 6; i++) {
        pcmEvents.dispatchEvent(new CustomEvent<PcmChunkDetail>("chunk", { detail: { samples, ts: Date.now() } }));
      }
      await new Promise((r) => setTimeout(r, 0));
    });
    // Either mid or wide must be opaque. Wide is the expected state at
    // this amplitude but mid is acceptable if the envelope hasn't
    // crossed APERTURE_TO_WIDE by chunk 6 — what we're testing is
    // that *some* open-mouth state is active, not which one.
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const closed = screen.getByTestId("broadcast-avatar-frame-body") as HTMLElement;
    const anyOpen = parseFloat(wide.style.opacity) > 0 || parseFloat(mid.style.opacity) > 0;
    expect(anyOpen).toBe(true);
    // Closed sprite stays at opacity 1 as the base layer — mid/wide
    // overlay on top of it. Previously closed faded 1→0 in lockstep
    // with mid/wide rising 0→1, which meant during the 50ms transition
    // both layers sat near opacity 0.5 and the page background flashed
    // through the avatar. Pinning closed at 1 makes those crossfades
    // additive (mouth-shape morph) instead of subtractive (full-body
    // flash). The mood sprites are designed so mid/wide fully occlude
    // the closed body when at opacity 1, so the visual result during
    // steady-state speaking is still the open-mouth sprite — only the
    // transient transition window is no longer transparent.
    expect(closed.style.opacity).toBe("1");
  });

  it("processes chunks even when tts.speaking starts false (always-attached listener race fix)", async () => {
    // The runner now emits speaking=true from the FIRST PCM chunk
    // (deferred from noteLine to avoid the 2-3s Piper-startup gap).
    // The page receives `tts.state` and `tts.audio_chunk` in close
    // succession, but React processes the speaking-state setState
    // asynchronously. If the chunk listener were gated on
    // `tts.speaking`, the very chunk that flipped the flag could
    // be dispatched on `pcmEvents` before the listener attached
    // — silently lost. The always-attached listener removes that
    // race by processing every chunk regardless of speaking state.
    render(<Avatar currentUtterance={idleTts} />);
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    expect(wide.style.opacity).toBe("0");
    expect(mid.style.opacity).toBe("0");
    const samples = makeLoudVowelChunk(1024, 22050);
    await act(async () => {
      // Dispatch chunks while speaking is still false — these would
      // be dropped under the previous gated-listener design.
      for (let i = 0; i < 6; i++) {
        pcmEvents.dispatchEvent(new CustomEvent<PcmChunkDetail>("chunk", { detail: { samples, ts: Date.now() } }));
      }
      await new Promise((r) => setTimeout(r, 0));
    });
    const anyOpen = parseFloat(wide.style.opacity) > 0 || parseFloat(mid.style.opacity) > 0;
    expect(anyOpen).toBe(true);
  });

  it("opens to mid the moment a new utterance starts (phantom-syllable seed, before any PCM)", () => {
    // tts.utterance.start fires BEFORE Piper produces any PCM —
    // ~70ms ahead of first audio. Without a phantom-syllable pulse,
    // the mouth waits for the first chunk to arrive AND the chunk-
    // throttle + Socket.IO + reducer + DOM paint round-trip (~50–100ms
    // total) before opening, so viewers experience: subtitle → audio
    // → ~80ms gap → mouth. The phantom syllable closes the gap by
    // driving synthetic mouth motion until real PCM takes over; this
    // test pins the FIRST tick of that cycle (mid) so a regression in
    // the seed-on-mount path fails loudly.
    const startedNoAudio = {
      id: "u-anticipation",
      text: "speaking",
      intent: "round_start",
      mood: "neutral" as const,
      estimatedDurationMs: 2000,
      startedAt: Date.now(),
      // start envelope has fired but audio_started has NOT — this is
      // the production cold-start window where the phantom syllable
      // should land.
      audioStartedAt: null,
      audioEndedAt: null,
    };
    render(<Avatar currentUtterance={startedNoAudio} />);
    const closed = screen.getByTestId("broadcast-avatar-frame-body") as HTMLElement;
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    // First phantom tick = 0.20 → mid state. Closed remains pinned
    // at 1 (base layer); mid overlays at 1; wide stays at 0.
    expect(mid.style.opacity).toBe("1");
    expect(wide.style.opacity).toBe("0");
    expect(closed.style.opacity).toBe("1");
  });

  it("cycles the phantom syllable through mid + wide while audioStartedAt stays null", () => {
    // The phantom-syllable cycle replaces the previous static lead-in
    // (which seeded 0.20 once and held). With the cycle, each 80ms
    // tick advances through PHANTOM_PATTERN = [0.20, 0.50, 0.22, 0.55],
    // alternating mid → wide → mid → wide. Without the cycle, viewers
    // saw a held-mid pose for ~80ms before real PCM arrived; the
    // cycle gives them visible mouth motion in that window. This test
    // pins that the cycle actually advances under fake timers — the
    // most likely regression is dropping the setInterval and
    // reverting to a one-shot seed.
    vi.useFakeTimers();
    const startedNoAudio = {
      id: "u-phantom-cycle",
      text: "speaking",
      intent: "round_start",
      mood: "neutral" as const,
      estimatedDurationMs: 2000,
      startedAt: Date.now(),
      audioStartedAt: null,
      audioEndedAt: null,
    };
    render(<Avatar currentUtterance={startedNoAudio} />);
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    // Tick 0 (synchronous on mount): aperture 0.20 → mid.
    expect(mid.style.opacity).toBe("1");
    expect(wide.style.opacity).toBe("0");
    // Tick 1 (after 80ms): aperture 0.50 → wide.
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(wide.style.opacity).toBe("1");
    expect(mid.style.opacity).toBe("0");
    // Tick 2 (after another 80ms): aperture 0.22 → mid.
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(mid.style.opacity).toBe("1");
    expect(wide.style.opacity).toBe("0");
    // Tick 3 (after another 80ms): aperture 0.55 → wide.
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(wide.style.opacity).toBe("1");
    vi.useRealTimers();
  });

  it("stops the phantom cycle when audioStartedAt flips non-null (real PCM takes over)", () => {
    // The cycle MUST stop the moment real audio starts — otherwise
    // the synthetic ticks would keep clobbering the RMS-driven envelope
    // mid-utterance. Cleanup runs via React's effect-cleanup return
    // when the dep `currentUtterance.audioStartedAt` changes.
    vi.useFakeTimers();
    const baseUtterance = {
      id: "u-phantom-stop",
      text: "speaking",
      intent: "round_start",
      mood: "neutral" as const,
      estimatedDurationMs: 2000,
      startedAt: 1000,
      audioStartedAt: null,
      audioEndedAt: null,
    };
    const { rerender } = render(<Avatar currentUtterance={baseUtterance} />);
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    // First tick: mid.
    expect(mid.style.opacity).toBe("1");
    // Real audio starts. The cycle's cleanup runs; envelopeRef stays
    // at the most-recent phantom value (0.20) but no further ticks
    // will fire — the chunk listener is now the source of truth.
    rerender(
      <Avatar currentUtterance={{ ...baseUtterance, audioStartedAt: 1100 }} />,
    );
    // Advance well past the cycle's interval. If the cleanup didn't
    // run, the cycle would tick to 0.50 (wide) on this advance.
    act(() => {
      vi.advanceTimersByTime(800);
    });
    // The DOM still reflects the last phantom write (mid) — there's
    // been no real PCM yet to retarget it, but crucially the cycle
    // didn't keep ticking through wide.
    expect(mid.style.opacity).toBe("1");
    expect(wide.style.opacity).toBe("0");
    vi.useRealTimers();
  });

  it("tears down the phantom cycle on unmount (no orphan ticks)", () => {
    // Belt-and-braces: the same effect-cleanup path that stops the
    // cycle on audioStartedAt also runs on unmount. Without it, a
    // navigating-away page would leave a setInterval ticking on a
    // dead component (the ref writes inside applyAperture would
    // no-op since the refs are detached, but the interval itself
    // would keep allocating timers until GC). This test pins that
    // unmount actually clears both timers.
    vi.useFakeTimers();
    const startedNoAudio = {
      id: "u-phantom-unmount",
      text: "speaking",
      intent: "round_start",
      mood: "neutral" as const,
      estimatedDurationMs: 2000,
      startedAt: Date.now(),
      audioStartedAt: null,
      audioEndedAt: null,
    };
    const { unmount } = render(<Avatar currentUtterance={startedNoAudio} />);
    unmount();
    // If the interval / cap timer leaked, vitest's fake-timer
    // bookkeeping would still count them as scheduled. `getTimerCount`
    // returns the number of pending fake timers — should be 0 after
    // cleanup. (Vitest creates timers that don't escape the fake
    // scheduler, so this is a tight assertion.)
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("restarts the phantom cycle when a new utterance replaces the previous one mid-cycle", () => {
    // Back-to-back utterances each get their own phantom syllable.
    // When utterance A's cycle is mid-flight and B arrives (id
    // change), React's effect-cleanup tears down A's interval+cap
    // and the effect re-runs for B, arming a fresh cycle. Without
    // this, B would silently inherit A's already-fired ticks (or
    // worse, run two intervals concurrently).
    vi.useFakeTimers();
    const utteranceA = {
      id: "u-phantom-A",
      text: "first line",
      intent: "round_start",
      mood: "neutral" as const,
      estimatedDurationMs: 2000,
      startedAt: 1000,
      audioStartedAt: null,
      audioEndedAt: null,
    };
    const { rerender } = render(<Avatar currentUtterance={utteranceA} />);
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    // A's tick 0 → mid.
    expect(mid.style.opacity).toBe("1");
    // Advance partway into A's cycle (one tick = wide).
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(wide.style.opacity).toBe("1");
    // B arrives. A's cleanup runs, B's effect re-runs and the cycle
    // starts fresh — tick 0 of B = mid.
    const utteranceB = { ...utteranceA, id: "u-phantom-B", startedAt: 2000 };
    rerender(<Avatar currentUtterance={utteranceB} />);
    expect(mid.style.opacity).toBe("1");
    expect(wide.style.opacity).toBe("0");
    // B's tick 1 = wide. Critically, this confirms B's cycle is alive
    // and ticking on its OWN schedule (anchored to B's effect run, not
    // A's already-fired ticks).
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(wide.style.opacity).toBe("1");
    expect(mid.style.opacity).toBe("0");
    vi.useRealTimers();
  });

  it("caps the phantom cycle at PHANTOM_MAX_MS so a stalled audio_started can't loop unbounded", () => {
    // If `audioStartedAt` never flips (Piper stall, dropped envelope,
    // pathological runner state), the cycle MUST stop on its own so
    // the mouth doesn't churn unboundedly. The hard cap is 500ms; at
    // 80ms per tick the cycle fires ~6 ticks before it caps, then
    // holds the most-recent phantom value.
    vi.useFakeTimers();
    const startedNoAudio = {
      id: "u-phantom-cap",
      text: "speaking",
      intent: "round_start",
      mood: "neutral" as const,
      estimatedDurationMs: 2000,
      startedAt: Date.now(),
      audioStartedAt: null,
      audioEndedAt: null,
    };
    render(<Avatar currentUtterance={startedNoAudio} />);
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    // Burn well past PHANTOM_MAX_MS. Without the cap, the cycle would
    // keep alternating mid/wide indefinitely on every 80ms boundary.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // The interval is gone; whatever state the cycle landed on at the
    // cap holds. With cap=500ms and tick=80ms, the last tick before
    // cap fires at t=480ms (i=6, pattern[6 % 4] = pattern[2] = 0.22 →
    // mid). Pin that we end on mid (not wide).
    expect(mid.style.opacity).toBe("1");
    expect(wide.style.opacity).toBe("0");
    // Another 1s with no audio_started — still no further ticks. The
    // mid-vs-wide opacities are unchanged from the cap moment.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(mid.style.opacity).toBe("1");
    expect(wide.style.opacity).toBe("0");
    vi.useRealTimers();
  });

  it("snaps mouth closed when audio_ended synthesises audioStartedAt (Piper crash before PCM)", () => {
    // Regression guard: when Piper crashes before producing any
    // audio, the bus reducer's `tts.utterance.audio_ended` handler
    // synthesises `audioStartedAt = audioEndedAt = now()` in a
    // single state update. `isSpeaking` evaluates the resulting
    // utterance as false (audioEndedAt is non-null), but it ALSO
    // evaluated the previous "anticipation pulse fired" state as
    // false (audioStartedAt was null) — so a `[speaking]`-only dep
    // list wouldn't re-run the snap-closed effect. Without
    // `audioEndedAt` in the deps, the mouth would stick on mid
    // until the next utterance.
    const startedNoAudio = {
      id: "u-piper-crash",
      text: "speaking",
      intent: "round_start",
      mood: "neutral" as const,
      estimatedDurationMs: 2000,
      startedAt: Date.now(),
      audioStartedAt: null,
      audioEndedAt: null,
    };
    const { rerender } = render(<Avatar currentUtterance={startedNoAudio} />);
    const closed = screen.getByTestId("broadcast-avatar-frame-body") as HTMLElement;
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    // Anticipation seeded mid.
    expect(mid.style.opacity).toBe("1");

    // Now simulate the audio_ended synthesis: both fields land at the
    // same timestamp in a single render (matches the reducer behaviour
    // — see `tts.utterance.audio_ended` handler in overlayBus.ts).
    const at = Date.now();
    rerender(
      <Avatar
        currentUtterance={{ ...startedNoAudio, audioStartedAt: at, audioEndedAt: at }}
      />,
    );
    expect(mid.style.opacity).toBe("0");
    expect(closed.style.opacity).toBe("1");
  });

  it("does NOT fire anticipation when audioStartedAt is already set (mid-utterance remount)", () => {
    // Mounting an Avatar with an utterance whose audio has already
    // started should leave the mouth closed (the PCM-driven path is
    // the source of truth from this point forward — anything we
    // overwrite would just be a flash before the next chunk
    // re-asserts state).
    const audioInFlight = {
      id: "u-mid-flight",
      text: "speaking",
      intent: "round_start",
      mood: "neutral" as const,
      estimatedDurationMs: 2000,
      startedAt: Date.now() - 500,
      audioStartedAt: Date.now() - 400,
      audioEndedAt: null,
    };
    render(<Avatar currentUtterance={audioInFlight} />);
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    expect(mid.style.opacity).toBe("0");
    expect(wide.style.opacity).toBe("0");
  });

  it("snaps mid/wide to opacity 0 + closed back to opacity 1 when speaking flips false mid-utterance", async () => {
    const { rerender } = render(<Avatar currentUtterance={speakingTts} />);
    // Drive the avatar into wide first.
    const samples = makeLoudVowelChunk(1024, 22050);
    await act(async () => {
      for (let i = 0; i < 6; i++) {
        pcmEvents.dispatchEvent(new CustomEvent<PcmChunkDetail>("chunk", { detail: { samples, ts: Date.now() } }));
      }
      await new Promise((r) => setTimeout(r, 0));
    });
    rerender(<Avatar currentUtterance={idleTts} />);
    const closed = screen.getByTestId("broadcast-avatar-frame-body") as HTMLElement;
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    expect(mid.style.opacity).toBe("0");
    expect(wide.style.opacity).toBe("0");
    // Closed must restore to opacity 1 — a regression that dropped
    // this would leave the avatar fully invisible (closed=mid=wide=0)
    // between utterances, which is exactly the kind of silent failure
    // the reviewer flagged.
    expect(closed.style.opacity).toBe("1");
  });
});

describe("Lipsync end-to-end (real bus → Avatar)", () => {
  // Integration test the audit flagged as missing. Mounts BOTH the
  // bus listener (via useOverlayState) AND a real Avatar in the same
  // tree, then drives chunks through the SAME postMessage path the
  // runner uses. Catches:
  //   - pcmEvents singleton identity (Avatar's listener is bound to
  //     the SAME EventTarget the bus dispatches on)
  //   - useOverlayState attach race vs first chunk (replay buffer)
  //   - tts.state envelope flowing through to <Avatar tts={...}>
  //   - Real base64 round-trip through decodePcmEnvelope, not direct
  //     dispatch on pcmEvents

  beforeEach(() => {
    window.sessionStorage.clear();
    __resetReplayBuffersForTests();
  });

  function Host() {
    const state = useOverlayState();
    return <Avatar currentUtterance={state.currentUtterance} mood={state.stats.mood} />;
  }

  it("end-to-end: real postMessage envelopes through useOverlayState drive Avatar's mouth", async () => {
    render(<Host />);
    // Yield so useOverlayState's useEffect mounts the message listener.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // Step 1: tts.utterance.start — sets currentUtterance, no audio yet.
    await act(async () => {
      dispatchOverlayEvent("tts.utterance.start", {
        id: "u-int-1",
        text: "test line",
        intent: "round_start",
        mood: "neutral",
        estimatedDurationMs: 1500,
        at: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    // Step 2: tts.utterance.audio_started — flips isSpeaking true.
    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_started", { id: "u-int-1", at: Date.now() });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("broadcast-avatar").getAttribute("data-speaking")).toBe("true");

    // Step 3: a single batch of 6 loud chunks via the new envelope.
    const samples = makeLoudVowelChunk(1024, 22050);
    const u8 = new Uint8Array(samples.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);
    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_batch", {
        id: "u-int-1",
        sampleRate: 22050,
        chunks: Array.from({ length: 6 }, (_, i) => ({ samples: b64, ts: Date.now() + i })),
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    const anyOpen = parseFloat(mid.style.opacity) > 0 || parseFloat(wide.style.opacity) > 0;
    expect(anyOpen, "mouth did not open after 6 loud chunks via real bus").toBe(true);

    // pcm stats incremented PER CHUNK inside the batch — proves the
    // bus iterated and dispatched per-entry, not just per-envelope.
    const stats = (window as unknown as { __pgPcmStats?: { received: number; dispatched: number } }).__pgPcmStats;
    expect(stats?.received ?? 0).toBeGreaterThanOrEqual(6);
    expect(stats?.dispatched ?? 0).toBeGreaterThanOrEqual(6);
  });

  it("end-to-end: chunks posted before Avatar mounts are replayed when Avatar attaches", async () => {
    // Simulate the cold-start race: chunks arrive on the bus BEFORE
    // Avatar's useEffect attaches its listener. With the pcm replay
    // queue Avatar must drain on mount, the very first chunks of the
    // session still reach the mouth.
    const samples = makeLoudVowelChunk(1024, 22050);
    const u8 = new Uint8Array(samples.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);

    // Mount the bus FIRST without Avatar; chunks decoded and pushed to
    // the replay queue but no listener consumes the live dispatch.
    const { unmount } = renderHookForBus();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      dispatchOverlayEvent("tts.utterance.start", { id: "u-replay", text: "x", intent: "x", mood: "neutral", estimatedDurationMs: 1500, at: Date.now() });
      dispatchOverlayEvent("tts.utterance.audio_started", { id: "u-replay", at: Date.now() });
      dispatchOverlayEvent("tts.utterance.audio_batch", {
        id: "u-replay",
        sampleRate: 22050,
        chunks: Array.from({ length: 6 }, (_, i) => ({ samples: b64, ts: Date.now() + i })),
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    unmount();

    // Now mount Avatar with a speaking-state utterance — its useEffect
    // must drain the pcm replay queue and apply the missed chunks.
    const speakingNow = {
      id: "u-replay-2",
      text: "x",
      intent: "x",
      mood: "neutral" as const,
      estimatedDurationMs: 1500,
      startedAt: Date.now(),
      audioStartedAt: Date.now(),
      audioEndedAt: null,
    };
    render(<Avatar currentUtterance={speakingNow} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const mid = screen.getByTestId("broadcast-avatar-frame-mid") as HTMLElement;
    const wide = screen.getByTestId("broadcast-avatar-frame-wide") as HTMLElement;
    const anyOpen = parseFloat(mid.style.opacity) > 0 || parseFloat(wide.style.opacity) > 0;
    expect(anyOpen, "Avatar mounting after bus did not replay missed PCM chunks").toBe(true);
  });
});

/** Render-only helper for spinning up the bus hook in isolation. */
function renderHookForBus(): { unmount(): void } {
  function HookHost() {
    useOverlayState();
    return null;
  }
  const r = render(<HookHost />);
  return { unmount: () => r.unmount() };
}

/** Make a loud broadband chunk that pushes the avatar's RMS envelope
 *  above the `wide` aperture threshold. Three sine harmonics + low-
 *  amplitude noise mirror a real vowel's spectrum. */
function makeLoudVowelChunk(length: number, sampleRate: number): Int16Array {
  const out = new Int16Array(length);
  const fundamentals = [220, 440, 660];
  for (let i = 0; i < length; i++) {
    let s = 0;
    for (const f of fundamentals) s += Math.sin(2 * Math.PI * f * i / sampleRate);
    s = (s / fundamentals.length) * 0.6 + (Math.random() - 0.5) * 0.2;
    out[i] = Math.round(s * 16000);
  }
  return out;
}

describe("Avatar pure helpers", () => {
  it("rmsOf returns 0 for silence and a positive normalised value for a sine wave", async () => {
    const { __avatarInternals } = await import("./Avatar");
    const { rmsOf } = __avatarInternals;
    expect(rmsOf(new Int16Array(1024))).toBe(0);
    expect(rmsOf(new Int16Array(0))).toBe(0);
    const tone = new Int16Array(1024);
    for (let i = 0; i < tone.length; i++) {
      tone[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / 22050) * 16000);
    }
    const v = rmsOf(tone);
    // Sine peaks at 16000/32768 ≈ 0.49 normalised; RMS = peak/√2 ≈ 0.34.
    expect(v).toBeGreaterThan(0.30);
    expect(v).toBeLessThan(0.40);
  });

  it("rmsToAperture floors silence to 0 and saturates loud audio at 1.0", async () => {
    const { __avatarInternals } = await import("./Avatar");
    const { rmsToAperture } = __avatarInternals;
    expect(rmsToAperture(0)).toBe(0);
    expect(rmsToAperture(0.01)).toBe(0); // below RMS_FLOOR (0.02)
    // RMS floor 0.02, gain 3.5: aperture = (rms - 0.02) * 3.5, clamped 0..1.
    expect(rmsToAperture(0.05)).toBeCloseTo(0.105, 3);
    expect(rmsToAperture(0.10)).toBeCloseTo(0.28, 2);
    expect(rmsToAperture(0.30)).toBeCloseTo(0.98, 2);
    expect(rmsToAperture(0.40)).toBe(1);   // saturated
    expect(rmsToAperture(1.00)).toBe(1);   // clamped
  });

  it("mouthStateFor partitions [0,1] aperture into closed / mid / wide bands", async () => {
    const { __avatarInternals } = await import("./Avatar");
    const { mouthStateFor } = __avatarInternals;
    // Closed band: [0, APERTURE_TO_MID).
    expect(mouthStateFor(0)).toBe("closed");
    expect(mouthStateFor(0.05)).toBe("closed");
    expect(mouthStateFor(0.099)).toBe("closed");
    // Mid band: [APERTURE_TO_MID, APERTURE_TO_WIDE).
    expect(mouthStateFor(0.10)).toBe("mid");
    expect(mouthStateFor(0.20)).toBe("mid");
    expect(mouthStateFor(0.299)).toBe("mid");
    // Wide band: [APERTURE_TO_WIDE, 1.0].
    expect(mouthStateFor(0.30)).toBe("wide");
    expect(mouthStateFor(0.65)).toBe("wide");
    expect(mouthStateFor(1.00)).toBe("wide");
  });

  it("envelope follower constants stay in (0,1) and release is fast enough to close mouth between syllables", async () => {
    const { __avatarInternals } = await import("./Avatar");
    const { ATTACK_ALPHA, RELEASE_ALPHA } = __avatarInternals;
    expect(ATTACK_ALPHA).toBeGreaterThan(0);
    expect(ATTACK_ALPHA).toBeLessThan(1);
    expect(RELEASE_ALPHA).toBeGreaterThan(0);
    expect(RELEASE_ALPHA).toBeLessThan(1);
    // The previous tuning kept release slower than attack ("envelope
    // follower asymmetry"). For lipsync that smoothing was the wrong
    // shape — slow release pinned the mouth at >=mid for the whole
    // utterance. Release ≥ 0.45 ensures the envelope drops fast enough
    // to fall through `closed` during inter-syllable gaps (~80ms).
    expect(RELEASE_ALPHA).toBeGreaterThanOrEqual(0.45);
  });
});

describe("LobbyRadar", () => {
  it("renders nothing when there's no countdown", () => {
    const { container } = render(<LobbyRadar countdown={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the room code, opponent count, and remaining seconds", () => {
    render(
      <LobbyRadar
        countdown={{
          at: Date.now(),
          elapsedSec: 30,
          remainingSec: 60,
          playerCount: 2,
          roomCode: "ABC123",
        }}
      />,
    );
    const node = screen.getByTestId("broadcast-lobby-radar");
    expect(node.textContent).toContain("1 opponent");
    expect(node.textContent).toContain("ABC123");
    expect(node.textContent).toContain("60s");
  });

  it("uses 'Looking for opponents' phrasing when nobody has joined yet", () => {
    render(
      <LobbyRadar
        countdown={{
          at: Date.now(),
          elapsedSec: 5,
          remainingSec: 55,
          playerCount: 1, // just the bot itself
          roomCode: "XY7",
        }}
      />,
    );
    expect(screen.getByText(/Looking for opponents/)).toBeTruthy();
  });
});

describe("ThoughtFeed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when the thought list is empty", () => {
    const { container } = render(<ThoughtFeed thoughts={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one bubble per thought, newest-first preserved by parent", () => {
    const newer = thought({ id: "a", text: "newest thought", at: Date.now() });
    const older = thought({ id: "b", text: "older thought", at: Date.now() - 1000 });
    render(<ThoughtFeed thoughts={[newer, older]} />);
    const bubbles = screen.getAllByTestId("broadcast-thought-bubble");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].textContent).toContain("newest thought");
    expect(bubbles[1].textContent).toContain("older thought");
  });

  it("each bubble renders the 'Pricey thinks' prefix and the per-thought text", () => {
    render(<ThoughtFeed thoughts={[thought({ text: "streak says go high" })]} />);
    const bubble = screen.getByTestId("broadcast-thought-bubble");
    expect(bubble.textContent).toContain("streak says go high");
    expect(bubble.textContent?.toLowerCase()).toContain("pricey thinks");
  });

  it("attaches the intent as a data attribute so styles can branch per intent", () => {
    render(<ThoughtFeed thoughts={[thought({ intent: "strategy_rationale" })]} />);
    const bubble = screen.getByTestId("broadcast-thought-bubble");
    expect(bubble.getAttribute("data-intent")).toBe("strategy_rationale");
  });

  it("each bubble starts NOT dimmed and gains the 'dimmed' class after the per-thought dim threshold", () => {
    vi.useFakeTimers();
    const at = Date.now();
    render(<ThoughtFeed thoughts={[thought({ at })]} />);
    expect(screen.getByTestId("broadcast-thought-bubble").classList.contains("dimmed")).toBe(false);
    act(() => { vi.advanceTimersByTime(3500); });
    expect(screen.getByTestId("broadcast-thought-bubble").classList.contains("dimmed")).toBe(true);
  });

  it("auto-hides stale entries past HIDE_AFTER_MS so an idle gap can't strand the stack", () => {
    // Per-thought ttl protects against a quiet gap leaving the last
    // few thoughts on screen forever — the bus FIFO only evicts when
    // new thoughts arrive to push them out.
    vi.useFakeTimers();
    const at = Date.now();
    // Pin a stable id and reuse the SAME thought object reference on
    // rerender. A fresh-id rerender would test the "new thought
    // arrived" path instead of the "old thought aged out" path the
    // test name claims — which is what tripped up the original.
    const stale = thought({ id: "stale", at });
    const { rerender } = render(<ThoughtFeed thoughts={[stale]} />);
    expect(screen.queryByTestId("broadcast-thought-bubble")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(31_000); });
    rerender(<ThoughtFeed thoughts={[stale]} />);
    expect(screen.queryByTestId("broadcast-thought-bubble")).toBeNull();
  });
});
