/**
 * Tests for PlayWithFriendsCard — the multiplayer hero on the home page.
 * Replaces the lonely <button.home-mp-btn> below the mode grid.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders } from "./testUtils";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import PlayWithFriendsCard from "../components/home/PlayWithFriendsCard";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("PlayWithFriendsCard", () => {
  it("renders the title and subtitle", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lobbies: [] }) }),
    );
    renderWithProviders(<PlayWithFriendsCard onClick={vi.fn()} />);
    expect(screen.getByText(/play with friends/i)).toBeInTheDocument();
    // The subtitle now teases the invite-reward buff. Anchor on "share"
    // and the "+25%" magnitude — both stable across copy tweaks.
    expect(screen.getByTestId("pwf-subtitle")).toHaveTextContent(/share/i);
    expect(screen.getByTestId("pwf-subtitle")).toHaveTextContent(/\+25%/);
  });

  it("invokes onClick when the card is clicked", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lobbies: [] }) }),
    );
    const onClick = vi.fn();
    renderWithProviders(<PlayWithFriendsCard onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("shows the live game count once the lobbies fetch resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ lobbies: [{ code: "AAAA" }, { code: "BBBB" }] }),
      }),
    );
    renderWithProviders(<PlayWithFriendsCard onClick={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("pwf-live-count")).toHaveTextContent(/2 game|2 games/i);
    });
  });

  it("hides the live indicator when offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));
    renderWithProviders(<PlayWithFriendsCard onClick={vi.fn()} />);
    // Wait for the hook to settle, then assert the live count chip is gone.
    await waitFor(() => {
      expect(screen.queryByTestId("pwf-live-count")).not.toBeInTheDocument();
    });
  });

  it("renders the kawaii hero illustration in the artwork slot", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ lobbies: [] }) }),
    );
    renderWithProviders(<PlayWithFriendsCard onClick={vi.fn()} />);
    const stack = screen.getByTestId("pwf-avatar-stack");
    const imgs = stack.querySelectorAll("img");
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute("src")).toMatch(/friends-hero/);
  });
});
