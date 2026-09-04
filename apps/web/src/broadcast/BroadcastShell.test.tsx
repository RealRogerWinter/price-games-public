/**
 * Tests for BroadcastShell — the wrapper that activates a 1920×1080 stage
 * layout when the URL has ?broadcast=1, and is a no-op otherwise.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import BroadcastShell from "./BroadcastShell";
import BroadcastNavHandle, { BROADCAST_NAV_GLOBAL } from "./BroadcastNavHandle";

function setSearch(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
}

describe("BroadcastShell", () => {
  beforeEach(() => {
    document.body.classList.remove("broadcast");
    setSearch("");
  });

  afterEach(() => {
    document.body.classList.remove("broadcast");
    setSearch("");
  });

  it("renders children unchanged when broadcast mode is off", () => {
    setSearch("");
    render(
      <BroadcastShell>
        <div data-testid="app-root">app content</div>
      </BroadcastShell>,
    );
    expect(screen.getByTestId("app-root")).toBeTruthy();
    expect(screen.queryByTestId("broadcast-shell")).toBeNull();
    expect(screen.queryByTestId("broadcast-stage")).toBeNull();
  });

  it("mounts the glass-overlay shell with all panels in broadcast mode", () => {
    // The shell renders panels ON TOP of the unscaled game canvas.
    // Children render at native size; panels float on alpha glass
    // over the letterbox margins. See BroadcastShell.tsx for the
    // rationale of dropping the original stage-with-scaled-game
    // layout in favour of overlays.
    setSearch("?broadcast=1");
    render(
      <BroadcastShell>
        <div data-testid="app-root">app content</div>
      </BroadcastShell>,
    );
    // Game children still render unwrapped (no transform: scale).
    expect(screen.getByTestId("app-root")).toBeTruthy();
    // Shell + every panel mount.
    expect(screen.getByTestId("broadcast-shell")).toBeTruthy();
    expect(screen.getByTestId("broadcast-header")).toBeTruthy();
    // GiveawayBanner — top-right glass block mirroring the HeaderBar.
    expect(screen.getByTestId("broadcast-giveaway")).toBeTruthy();
    expect(screen.getByTestId("broadcast-panel-left")).toBeTruthy();
    expect(screen.getByTestId("broadcast-panel-right")).toBeTruthy();
    expect(screen.getByTestId("broadcast-panel-bottom")).toBeTruthy();
    // "Pricey's brain" wraps the NN visualisation panels in the left
    // panel; the static BotCard + RecentRounds blocks were removed
    // when the rail was repurposed for the brain panels.
    expect(screen.getByTestId("broadcast-brain")).toBeTruthy();
    expect(screen.getByTestId("broadcast-nn-stack")).toBeTruthy();
    // ChatOverlay inside the right panel.
    expect(screen.getByTestId("broadcast-chat")).toBeTruthy();
    // MusicTicker inside the footer.
    expect(screen.getByTestId("broadcast-music-ticker")).toBeTruthy();
  });

  it("does not mount any speaking indicator (removed in UI-polish pass)", () => {
    // The mic + bars indicator was deleted entirely — viewers have
    // the animated mouth on the avatar itself as the speaking cue,
    // and a separate "is Pricey talking?" chip was redundant.
    setSearch("?broadcast=1");
    render(<BroadcastShell><div /></BroadcastShell>);
    expect(screen.queryByTestId("broadcast-speaking-indicator")).toBeNull();
  });

  it("renders the giveaway banner with the treasure-chest icon and CTA copy", () => {
    setSearch("?broadcast=1");
    render(<BroadcastShell><div /></BroadcastShell>);
    const banner = screen.getByTestId("broadcast-giveaway");
    // Icon + the headline + CTA text all render.
    expect(banner.querySelector("img.broadcast-giveaway-icon")).toBeTruthy();
    expect(banner.textContent?.toLowerCase()).toContain("$50");
    expect(banner.textContent?.toLowerCase()).toContain("price.games");
    // Sits at the top of the right edge, above the chat rail in the
    // DOM order so the visual stack on the right reads top→bottom.
    const rightPanel = screen.getByTestId("broadcast-panel-right");
    const shell = screen.getByTestId("broadcast-shell");
    const children = Array.from(shell.children);
    expect(children.indexOf(banner)).toBeLessThan(children.indexOf(rightPanel));
  });

  it("mounts the lazy-loaded Avatar in the left rail under broadcast=1", async () => {
    // The Suspense boundary in BroadcastShell wraps a `React.lazy(() => import('./panels/Avatar'))`.
    // This guards the chunk-split contract: if a future eager import
    // accidentally inlines the Avatar into the main bundle, this test
    // would still pass — but a regression that breaks the boundary
    // wiring (forgetting Suspense, mounting outside broadcast mode,
    // etc.) is caught here.
    setSearch("?broadcast=1");
    render(
      <BroadcastShell>
        <div data-testid="app-root">app content</div>
      </BroadcastShell>,
    );
    const avatar = await screen.findByTestId("broadcast-avatar");
    expect(avatar).toBeTruthy();
    // Avatar must live inside the left panel rail, above the brain.
    const leftPanel = screen.getByTestId("broadcast-panel-left");
    expect(leftPanel.contains(avatar)).toBe(true);
  });

  it("does not mount the lazy Avatar when broadcast mode is off", () => {
    setSearch("");
    render(
      <BroadcastShell>
        <div data-testid="app-root">app content</div>
      </BroadcastShell>,
    );
    expect(screen.queryByTestId("broadcast-avatar")).toBeNull();
  });

  it("does not mount the shell when broadcast mode is off", () => {
    setSearch("");
    render(
      <BroadcastShell>
        <div data-testid="app-root">app content</div>
      </BroadcastShell>,
    );
    expect(screen.getByTestId("app-root")).toBeTruthy();
    expect(screen.queryByTestId("broadcast-shell")).toBeNull();
    expect(screen.queryByTestId("broadcast-header")).toBeNull();
  });

  it("adds body.broadcast on mount and removes on unmount when active", () => {
    setSearch("?broadcast=1");
    const { unmount } = render(
      <BroadcastShell>
        <div>app</div>
      </BroadcastShell>,
    );
    expect(document.body.classList.contains("broadcast")).toBe(true);
    unmount();
    expect(document.body.classList.contains("broadcast")).toBe(false);
  });

  it("does not touch body class when not in broadcast mode", () => {
    document.body.classList.add("preexisting");
    setSearch("");
    const { unmount } = render(
      <BroadcastShell>
        <div>app</div>
      </BroadcastShell>,
    );
    expect(document.body.classList.contains("broadcast")).toBe(false);
    expect(document.body.classList.contains("preexisting")).toBe(true);
    unmount();
    expect(document.body.classList.contains("preexisting")).toBe(true);
    document.body.classList.remove("preexisting");
  });

  it("renders the 'Pricey's brain' section header above the NN stack", () => {
    setSearch("?broadcast=1");
    render(<BroadcastShell><div /></BroadcastShell>);
    const brain = screen.getByTestId("broadcast-brain");
    expect(brain.getAttribute("aria-label")).toBe("Pricey's brain");
    expect(brain.textContent).toContain("Pricey's brain");
    expect(brain.contains(screen.getByTestId("broadcast-nn-stack"))).toBe(true);
  });

  it("renders a per-panel labeled card around each NN visualization", () => {
    // Each NN panel sits inside a `.broadcast-nn-card` wrapper with an
    // `<h3>` header so viewers can read what each viz is showing
    // without having to know the parent "Pricey's brain" framing.
    setSearch("?broadcast=1");
    render(<BroadcastShell><div /></BroadcastShell>);
    const labels = [
      "Neural Network",
      "Price Guess",
      "Last 10 Guesses",
    ];
    for (const label of labels) {
      expect(screen.getByText(label, { selector: "h3" })).toBeTruthy();
    }
    // The first card (NeuralNet) is marked as the dominant focal panel
    // so CSS can give it `flex: 1 1 auto`. A `data-dominant="1"` hook
    // is the contract between the shell and the stylesheet.
    expect(screen.getByTestId("nn-card-mlp").getAttribute("data-dominant")).toBe("1");
  });

  it("preserves body.broadcast when a transient hook consumer unmounts", () => {
    // Regression: a previous design had useBroadcastMode set the body class
    // itself. That meant any consumer (e.g. AuthModal) unmounting would
    // strip the class while the shell was still mounted, silently breaking
    // the stage CSS. Body-class ownership now lives only in BroadcastShell.
    setSearch("?broadcast=1");
    render(
      <BroadcastShell>
        <div data-testid="app">app</div>
      </BroadcastShell>,
    );
    expect(document.body.classList.contains("broadcast")).toBe(true);

    // Mount a separate consumer that calls useBroadcastMode and unmount it.
    // The shell remains mounted; body.broadcast must persist.
    const { unmount: unmountConsumer } = render(
      <ConsumerProbe />,
    );
    unmountConsumer();
    expect(document.body.classList.contains("broadcast")).toBe(true);
  });

  it("keeps broadcast mode true for a consumer that first mounts AFTER an SPA soft-nav drops ?broadcast=1 (regression)", async () => {
    // Closes the leak: BroadcastShell must seed BroadcastModeContext ONCE
    // at its own mount, so a component that only mounts LATER — on a
    // route the streamer-bot driver soft-navigates to via
    // `window.__pgBroadcastNav(url)` (BroadcastNavHandle) — still reads
    // the value BroadcastShell captured at startup, not a fresh read of
    // the (by then broadcast-param-less) URL.
    //
    // Against the old per-hook `useState(readFlag)` implementation this
    // test fails: LaterConsumer would independently read
    // `window.location.search` at ITS OWN mount time (after the nav to
    // `/leaderboard`, which carries no `?broadcast=1`) and get `false`
    // even while BroadcastShell's overlay is still actively rendering.
    setSearch("?broadcast=1");

    function LaterConsumer() {
      const broadcast = useBroadcastMode();
      return <div data-testid="later-consumer-value">{String(broadcast)}</div>;
    }

    render(
      <BroadcastShell>
        <MemoryRouter initialEntries={["/?broadcast=1"]}>
          {/* Mirrors App.tsx: BroadcastNavHandle sits as a sibling of
              <Routes> inside the router, registering
              window.__pgBroadcastNav for the bot driver. */}
          <BroadcastNavHandle />
          <Routes>
            <Route path="/" element={<div data-testid="home">home</div>} />
            {/* LaterConsumer does not exist anywhere in the tree until
                the bot navigates here — its very first render happens
                after the URL has already lost ?broadcast=1. */}
            <Route path="/leaderboard" element={<LaterConsumer />} />
          </Routes>
        </MemoryRouter>
      </BroadcastShell>,
    );

    // BroadcastShell's own overlay is up, confirming broadcast mode is
    // active for the session.
    expect(screen.getByTestId("broadcast-shell")).toBeTruthy();
    expect(screen.getByTestId("home")).toBeTruthy();

    // Simulate the bot driver's mid-broadcast soft-nav to a URL with NO
    // broadcast=1 param — exactly the scenario BroadcastNavHandle
    // documents as reachable (any `?broadcast=1` page exposes the
    // global, and nothing guarantees the target URL repeats the param).
    await act(async () => {
      window[BROADCAST_NAV_GLOBAL]?.("/leaderboard");
    });

    // BroadcastShell itself never remounted or re-derived anything —
    // its overlay is still up.
    expect(screen.getByTestId("broadcast-shell")).toBeTruthy();

    // LaterConsumer mounts for the very first time here, on a URL with
    // no broadcast param. It must still see `true`.
    const later = screen.getByTestId("later-consumer-value");
    expect(later.textContent).toBe("true");
  });
});

import { useBroadcastMode } from "./useBroadcastMode";

/** Test probe that calls useBroadcastMode then unmounts. */
function ConsumerProbe() {
  useBroadcastMode();
  return null;
}
