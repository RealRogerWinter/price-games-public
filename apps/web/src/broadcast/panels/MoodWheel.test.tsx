/**
 * Tests for MoodWheel — the circular mood-indicator panel that
 * replaces the static MoodIndicator card. Geometry/math is covered
 * exhaustively in moodWheelGeometry.test.ts; these tests focus on
 * the React render layer: sector rendering, hub readout, pointer
 * placement, direction caret, cold-start, streak gating, and
 * accessibility.
 */

import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import MoodWheel from "./MoodWheel";
import type { BotStats, MoodSnapshot } from "../state/overlayBus";
import { MOOD_REGISTRY, type Mood } from "@price-game/shared";
import { SECTOR_ORDER, WHEEL_PALETTE, sectorAnchorAngle, wheelIndicatorAngle } from "./moodWheelGeometry";

afterEach(() => cleanup());

const stats = (over: Partial<BotStats> = {}): BotStats => ({
  wins: 0,
  losses: 0,
  streak: 0,
  ...over,
});

const snap = (over: Partial<MoodSnapshot> = {}): MoodSnapshot => ({
  mood: "neutral",
  vibe: 0,
  morale: 0,
  streak: 0,
  ...over,
});

describe("MoodWheel — render shape", () => {
  it("renders a wheel root with data-testid + role=status + data-mood", () => {
    render(<MoodWheel moodSnapshot={snap({ mood: "happy" })} stats={stats({ mood: "happy" })} />);
    const root = screen.getByTestId("mood-wheel");
    expect(root).toBeTruthy();
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("data-mood")).toBe("happy");
  });

  it("renders one transparent sector hit-region per mood, tagged with mood + state", () => {
    render(<MoodWheel moodSnapshot={snap({ mood: "happy" })} stats={stats({ mood: "happy" })} />);
    for (const mood of SECTOR_ORDER) {
      const sector = screen.getByTestId(`mood-wheel-sector-${mood}`);
      expect(sector.getAttribute("data-mood")).toBe(mood);
      expect(["active", "adjacent", "dim"]).toContain(sector.getAttribute("data-state"));
      expect(sector.getAttribute("fill")).toBe("transparent");
    }
  });

  it("paints the rim with a conic-gradient backdrop carrying every WHEEL_PALETTE colour", () => {
    render(<MoodWheel moodSnapshot={snap()} stats={stats()} />);
    const ring = screen.getByTestId("mood-wheel-ring");
    const style = ring.getAttribute("style") ?? "";
    expect(style).toContain("conic-gradient");
    for (const mood of SECTOR_ORDER) {
      // CSS may serialise hex colours as their rgb() form, so check both.
      const hex = WHEEL_PALETTE[mood as Mood].toLowerCase();
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const rgb = `rgb(${r}, ${g}, ${b})`;
      expect(style.toLowerCase().includes(hex) || style.includes(rgb)).toBe(true);
    }
  });

  it("renders a horizontal text label at every sector position around the rim", () => {
    render(<MoodWheel moodSnapshot={snap({ mood: "neutral" })} stats={stats({ mood: "neutral" })} />);
    for (const mood of SECTOR_ORDER) {
      const label = screen.getByTestId(`mood-wheel-rim-label-${mood}`);
      expect(label.textContent).toBe(MOOD_REGISTRY[mood as Mood].displayLabel);
      // Text MUST NOT be rotated — Twitch encoder mangles arc-text.
      expect(label.getAttribute("transform") ?? "").not.toMatch(/rotate/);
    }
  });

  it("highlights the active rim label with data-state=active and dims the rest", () => {
    render(<MoodWheel moodSnapshot={snap({ mood: "frustrated" })} stats={stats({ mood: "frustrated" })} />);
    const active = screen.getByTestId("mood-wheel-rim-label-frustrated");
    expect(active.getAttribute("data-state")).toBe("active");
    // Frustrated (10:30, idx 7) is sector-distant from happy (3:00, idx 2)
    // — pick a label that's three hops away regardless of cycle direction.
    const distant = screen.getByTestId("mood-wheel-rim-label-happy");
    expect(distant.getAttribute("data-state")).toBe("dim");
  });

  it("does not render any rim emoji glyphs (replaced by text labels)", () => {
    render(<MoodWheel moodSnapshot={snap()} stats={stats()} />);
    expect(document.querySelector(".broadcast-mood-wheel-glyph")).toBeNull();
  });

  it("hub shows the active mood's emoji + uppercase displayLabel", () => {
    render(<MoodWheel moodSnapshot={snap({ mood: "elated" })} stats={stats({ mood: "elated" })} />);
    expect(screen.getByTestId("mood-wheel-emoji").textContent).toBe(MOOD_REGISTRY.elated.emoji);
    expect(screen.getByTestId("mood-wheel-label").textContent).toBe(MOOD_REGISTRY.elated.displayLabel);
  });
});

describe("MoodWheel — indicator placement", () => {
  it("rotates the indicator group to the active mood's anchor angle", () => {
    render(<MoodWheel moodSnapshot={snap({ mood: "frustrated" })} stats={stats({ mood: "frustrated" })} />);
    const indicator = screen.getByTestId("mood-wheel-indicator");
    expect(indicator.getAttribute("data-angle")).toBe(String(sectorAnchorAngle("frustrated")));
  });

  it("anchors at neutral (180°) on the legacy stats-only path (no snapshot, mood from stats)", () => {
    render(<MoodWheel moodSnapshot={null} stats={stats({ mood: "neutral" })} />);
    const indicator = screen.getByTestId("mood-wheel-indicator");
    expect(indicator.getAttribute("data-angle")).toBe("180");
  });

  it("hides the indicator entirely on cold-start (no snapshot, no stats.mood)", () => {
    render(<MoodWheel moodSnapshot={null} stats={{ wins: 0, losses: 0, streak: 0 }} />);
    expect(screen.queryByTestId("mood-wheel-indicator")).toBeNull();
  });

  it("publishes the continuous (vibe-deflected) angle on data-target-angle", () => {
    // happy at vibe=3 (peak of the happy band) lands the indicator
    // 18° clockwise of the sector anchor — toward elated, near the
    // gradient intermediate stop. This is the visible behaviour the
    // user asked for: the wheel moves between rounds even when the
    // mood label hasn't changed, drifting into intermediary positions.
    render(<MoodWheel moodSnapshot={snap({ mood: "happy", vibe: 3 })} stats={stats({ mood: "happy" })} />);
    const indicator = screen.getByTestId("mood-wheel-indicator");
    // Sector anchor stays as the registry-stable identity for tests.
    expect(indicator.getAttribute("data-angle")).toBe(String(sectorAnchorAngle("happy")));
    // Continuous target angle adds the vibe-driven offset.
    expect(indicator.getAttribute("data-target-angle")).toBe(String(wheelIndicatorAngle("happy", 3)));
  });

  it("vibe drift (no mood-label change) shifts the target angle so the wheel reads as live", () => {
    const { rerender } = render(
      <MoodWheel moodSnapshot={snap({ mood: "neutral", vibe: 0 })} stats={stats({ mood: "neutral" })} />,
    );
    const before = screen.getByTestId("mood-wheel-indicator").getAttribute("data-target-angle");
    rerender(
      <MoodWheel moodSnapshot={snap({ mood: "neutral", vibe: 1.2 })} stats={stats({ mood: "neutral" })} />,
    );
    const after = screen.getByTestId("mood-wheel-indicator").getAttribute("data-target-angle");
    expect(after).not.toBe(before);
  });
});

describe("MoodWheel — direction caret", () => {
  it("shows a flat → caret with no neighbour label on cold start", () => {
    render(<MoodWheel moodSnapshot={snap({ mood: "neutral" })} stats={stats()} />);
    const caret = screen.getByTestId("mood-wheel-direction");
    expect(caret.textContent).toMatch(/→/);
    expect(caret.textContent).not.toMatch(/Confident|Tilted/);
  });

  it("shows ↗ + the next-positive neighbour label when vibe rises", () => {
    const { rerender } = render(
      <MoodWheel moodSnapshot={snap({ mood: "neutral", vibe: -0.5 })} stats={stats()} />,
    );
    rerender(
      <MoodWheel moodSnapshot={snap({ mood: "neutral", vibe: 1.2 })} stats={stats()} />,
    );
    const caret = screen.getByTestId("mood-wheel-direction");
    expect(caret.textContent).toMatch(/↗/);
    expect(caret.textContent).toMatch(/Focused/);
  });

  it("shows ↘ + the next-negative neighbour label when vibe falls", () => {
    const { rerender } = render(
      <MoodWheel moodSnapshot={snap({ mood: "neutral", vibe: 0.5 })} stats={stats()} />,
    );
    rerender(
      <MoodWheel moodSnapshot={snap({ mood: "neutral", vibe: -1.0 })} stats={stats()} />,
    );
    const caret = screen.getByTestId("mood-wheel-direction");
    expect(caret.textContent).toMatch(/↘/);
    expect(caret.textContent).toMatch(/Tilted/);
  });
});

describe("MoodWheel — cold start", () => {
  it("shows 'Warming up' and hides the pointer until first snapshot lands", () => {
    render(<MoodWheel moodSnapshot={null} stats={{ wins: 0, losses: 0, streak: 0 }} />);
    expect(screen.getByTestId("mood-wheel-label").textContent).toMatch(/Warming up/i);
    const root = screen.getByTestId("mood-wheel");
    expect(root.getAttribute("data-cold-start")).toBe("true");
  });

  it("exits cold-start once a moodSnapshot is provided", () => {
    const { rerender } = render(
      <MoodWheel moodSnapshot={null} stats={{ wins: 0, losses: 0, streak: 0 }} />,
    );
    rerender(<MoodWheel moodSnapshot={snap({ mood: "happy" })} stats={stats({ mood: "happy" })} />);
    const root = screen.getByTestId("mood-wheel");
    expect(root.getAttribute("data-cold-start")).toBe("false");
    expect(screen.getByTestId("mood-wheel-label").textContent).toBe(MOOD_REGISTRY.happy.displayLabel);
  });
});

describe("MoodWheel — streak pill", () => {
  it("hides the streak pill at |streak| < 2", () => {
    render(<MoodWheel moodSnapshot={snap({ streak: 1 })} stats={stats({ streak: 1 })} />);
    expect(screen.queryByTestId("mood-wheel-streak")).toBeNull();
  });

  it("shows a positive streak pill at streak >= 2", () => {
    render(<MoodWheel moodSnapshot={snap({ streak: 4 })} stats={stats({ streak: 4 })} />);
    const pill = screen.getByTestId("mood-wheel-streak");
    expect(pill.textContent).toMatch(/4/);
    expect(pill.textContent).toMatch(/▲/);
  });

  it("shows a negative streak pill at streak <= -2", () => {
    render(<MoodWheel moodSnapshot={snap({ streak: -3 })} stats={stats({ streak: -3 })} />);
    const pill = screen.getByTestId("mood-wheel-streak");
    expect(pill.textContent).toMatch(/3/);
    expect(pill.textContent).toMatch(/▼/);
  });
});

describe("MoodWheel — accessibility", () => {
  it("publishes an aria-live status with mood label + description + streak", () => {
    render(<MoodWheel moodSnapshot={snap({ mood: "confident", streak: 3 })} stats={stats({ streak: 3 })} />);
    const root = screen.getByTestId("mood-wheel");
    expect(root.getAttribute("aria-live")).toBe("polite");
    const label = root.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Confident/);
    expect(label).toMatch(MOOD_REGISTRY.confident.description);
    expect(label).toMatch(/3/);
  });
});
