/**
 * Tests for useInviteReward — subscribes to invite:reward_earned and
 * invite:welcome_bonus socket events, exposes earn state for the lobby
 * badge / post-match CTA / toast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useInviteReward } from "./useInviteReward";

interface MockSocket {
  handlers: Record<string, ((p: unknown) => void)[]>;
  on(event: string, h: (p: unknown) => void): void;
  off(event: string, h: (p: unknown) => void): void;
  emit(event: string, payload: unknown): void;
}

function makeSocket(): MockSocket {
  const handlers: MockSocket["handlers"] = {};
  return {
    handlers,
    on(event, h) {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(h);
    },
    off(event, h) {
      handlers[event] = (handlers[event] ?? []).filter((x) => x !== h);
    },
    emit(event, payload) {
      (handlers[event] ?? []).forEach((h) => h(payload));
    },
  };
}

vi.mock("../api/socket", () => ({
  getSocket: () => mockSocket,
}));

let mockSocket: MockSocket;
beforeEach(() => {
  mockSocket = makeSocket();
});

describe("useInviteReward", () => {
  it("starts with status 'none'", () => {
    const { result } = renderHook(() => useInviteReward());
    expect(result.current.status).toBe("none");
    expect(result.current.multiplier).toBe(1);
  });

  it("transitions to 'earned' on invite:reward_earned (host event)", () => {
    const { result } = renderHook(() => useInviteReward());
    act(() => {
      mockSocket.emit("invite:reward_earned", {
        source: "invite_host",
        multiplier: 1.25,
        matchesRemaining: 3,
        joinerDisplayName: "Alex",
      });
    });
    expect(result.current.status).toBe("earned");
    expect(result.current.multiplier).toBe(1.25);
    expect(result.current.matchesRemaining).toBe(3);
    expect(result.current.joinerDisplayName).toBe("Alex");
  });

  it("transitions to 'welcomed' on invite:welcome_bonus (joiner event)", () => {
    const { result } = renderHook(() => useInviteReward());
    act(() => {
      mockSocket.emit("invite:welcome_bonus", {
        source: "invite_joiner",
        multiplier: 1.10,
        matchesRemaining: 1,
      });
    });
    expect(result.current.status).toBe("welcomed");
    expect(result.current.multiplier).toBe(1.10);
    expect(result.current.matchesRemaining).toBe(1);
  });

  it("dismiss() resets status back to 'none'", () => {
    const { result } = renderHook(() => useInviteReward());
    act(() => {
      mockSocket.emit("invite:reward_earned", {
        source: "invite_host",
        multiplier: 1.25,
        matchesRemaining: 3,
        joinerDisplayName: "Alex",
      });
    });
    expect(result.current.status).toBe("earned");
    act(() => {
      result.current.dismiss();
    });
    expect(result.current.status).toBe("none");
  });

  it("unregisters listeners on unmount", () => {
    const { unmount } = renderHook(() => useInviteReward());
    expect(mockSocket.handlers["invite:reward_earned"]?.length ?? 0).toBeGreaterThan(0);
    unmount();
    expect(mockSocket.handlers["invite:reward_earned"]?.length ?? 0).toBe(0);
    expect(mockSocket.handlers["invite:welcome_bonus"]?.length ?? 0).toBe(0);
  });
});
