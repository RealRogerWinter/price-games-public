/**
 * Tests for RewardToastHost — global toast surfaced on invite-reward events.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders } from "./testUtils";
import { act, screen } from "@testing-library/react";
import RewardToastHost from "../components/multiplayer/RewardToastHost";

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
  vi.useFakeTimers();
});

describe("RewardToastHost", () => {
  it("renders nothing initially", () => {
    const { container } = renderWithProviders(<RewardToastHost />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a host-earn toast with the joiner name and pct", () => {
    renderWithProviders(<RewardToastHost />);
    act(() => {
      mockSocket.emit("invite:reward_earned", {
        source: "invite_host",
        multiplier: 1.25,
        matchesRemaining: 3,
        joinerDisplayName: "Alex",
      });
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/Friendship Boost/i)).toBeInTheDocument();
    expect(screen.getByText(/Alex joined your room/i)).toBeInTheDocument();
    expect(screen.getByText(/\+25%/)).toBeInTheDocument();
    expect(screen.getByText(/next 3 matches/i)).toBeInTheDocument();
  });

  it("shows a joiner welcome toast with the +10% framing", () => {
    renderWithProviders(<RewardToastHost />);
    act(() => {
      mockSocket.emit("invite:welcome_bonus", {
        source: "invite_joiner",
        multiplier: 1.10,
        matchesRemaining: 1,
      });
    });
    expect(screen.getByText(/Welcome bonus/i)).toBeInTheDocument();
    expect(screen.getByText(/\+10%/)).toBeInTheDocument();
    expect(screen.getByText(/next match/i)).toBeInTheDocument();
  });

  it("auto-dismisses after the timeout", () => {
    renderWithProviders(<RewardToastHost />);
    act(() => {
      mockSocket.emit("invite:welcome_bonus", {
        source: "invite_joiner",
        multiplier: 1.10,
        matchesRemaining: 1,
      });
    });
    expect(screen.queryByRole("status")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("dismisses on close-button click", () => {
    renderWithProviders(<RewardToastHost />);
    act(() => {
      mockSocket.emit("invite:welcome_bonus", {
        source: "invite_joiner",
        multiplier: 1.10,
        matchesRemaining: 1,
      });
    });
    const closeBtn = screen.getByRole("button", { name: /dismiss/i });
    act(() => {
      closeBtn.click();
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
