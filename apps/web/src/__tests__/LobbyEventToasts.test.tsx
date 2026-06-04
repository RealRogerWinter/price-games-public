import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import LobbyEventToasts from "../components/multiplayer/LobbyEventToasts";
import type { MultiplayerPlayer } from "@price-game/shared";

function makePlayer(id: string, name = `P${id}`): MultiplayerPlayer {
  return {
    id,
    displayName: name,
    avatar: "wizard",
    isHost: false,
    isConnected: true,
    totalScore: 0,
    isBot: false,
  } as MultiplayerPlayer;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LobbyEventToasts", () => {
  it("does not toast on the very first render (seeds the diff baseline)", () => {
    render(
      <LobbyEventToasts
        players={[makePlayer("a"), makePlayer("b")]}
        selfPlayerId="a"
      />,
    );
    expect(screen.queryByText(/joined|left/i)).not.toBeInTheDocument();
  });

  it("toasts a single 'X joined' on a single addition", () => {
    const initial = [makePlayer("a", "Alice")];
    const { rerender } = render(
      <LobbyEventToasts players={initial} selfPlayerId="a" />,
    );
    rerender(
      <LobbyEventToasts
        players={[...initial, makePlayer("b", "Bob")]}
        selfPlayerId="a"
      />,
    );
    expect(screen.getByText(/joined/i)).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("dismisses each toast independently after its own timer fires", () => {
    // Regression for the bug where the dismiss `useEffect` was keyed on
    // `[queue]` so each new toast reset the dismiss timers for ALL
    // already-displayed toasts. This test simulates two joins ~1 second
    // apart and asserts the first toast disappears at its own
    // 3.2s deadline (i.e. ~2.2s after the second toast appears),
    // independent of the second toast.
    const t0 = [makePlayer("a", "Alice")];
    const { rerender } = render(
      <LobbyEventToasts players={t0} selfPlayerId="a" />,
    );

    // First join at t=0
    rerender(
      <LobbyEventToasts
        players={[...t0, makePlayer("b", "Bob")]}
        selfPlayerId="a"
      />,
    );
    expect(screen.getByText("Bob")).toBeInTheDocument();

    // Second join at t=1000ms — Bob's toast is now ~1s old.
    act(() => { vi.advanceTimersByTime(1000); });
    rerender(
      <LobbyEventToasts
        players={[...t0, makePlayer("b", "Bob"), makePlayer("c", "Carol")]}
        selfPlayerId="a"
      />,
    );
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();

    // At t=3300ms (Bob is 3.3s old, Carol is 2.3s old): Bob should be
    // gone, Carol should still be visible. If the dismiss timers were
    // reset on every queue change (the old bug), Bob would still be
    // visible because his timer would have been re-armed at t=1000.
    act(() => { vi.advanceTimersByTime(2300); });
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    expect(screen.getByText("Carol")).toBeInTheDocument();

    // At t=4300ms: Carol should now also be dismissed.
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText("Carol")).not.toBeInTheDocument();
  });

  it("clears all timers on unmount", () => {
    const t0 = [makePlayer("a")];
    const { rerender, unmount } = render(
      <LobbyEventToasts players={t0} selfPlayerId="a" />,
    );
    rerender(
      <LobbyEventToasts
        players={[...t0, makePlayer("b", "Bob")]}
        selfPlayerId="a"
      />,
    );
    // Bob's toast is queued. Unmount before the dismiss timer fires.
    unmount();
    // No assertion about the DOM (unmounted) — the pass criterion is
    // simply that vi.advanceTimersByTime doesn't trigger any setState
    // on the unmounted component (would log a React warning, which
    // vitest treats as a failure under strict mode).
    act(() => { vi.advanceTimersByTime(5000); });
  });

  it("toasts a 'X left' when a player is removed", () => {
    const initial = [makePlayer("a", "Alice"), makePlayer("b", "Bob")];
    const { rerender } = render(
      <LobbyEventToasts players={initial} selfPlayerId="a" />,
    );
    rerender(
      <LobbyEventToasts players={[makePlayer("a", "Alice")]} selfPlayerId="a" />,
    );
    expect(screen.getByText(/left/i)).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });
});
