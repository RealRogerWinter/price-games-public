import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import LobbyScreen from "../components/multiplayer/LobbyScreen";
import { renderWithProviders, makeRoom, makePlayer } from "./testUtils";

describe("LobbyScreen", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/game/categories")) {
        return new Response(JSON.stringify({
          categories: [
            { name: "Electronics", count: 25 },
            { name: "Home & Kitchen", count: 20 },
            { name: "Beauty & Personal Care", count: 15 },
            { name: "Sports & Outdoors", count: 10 },
            { name: "Toys & Games", count: 10 },
          ],
        }));
      }
      return new Response(JSON.stringify({ rates: {} }));
    });
    // Mock clipboard
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    Object.assign(navigator, { clipboard: originalClipboard });
  });

  const defaultProps = {
    room: makeRoom({
      players: [
        makePlayer({ id: "host-1", displayName: "Alice", isHost: true }),
        makePlayer({ id: "player-2", displayName: "Bob" }),
      ],
      hostPlayerId: "host-1",
    }),
    playerId: "host-1",
    onStartRound: vi.fn(),
    onKickPlayer: vi.fn(),
    onChangeSettings: vi.fn(),
    onConfigureBots: vi.fn(),
    onLeave: vi.fn(),
  };

  it("displays room code", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    expect(screen.getByText("ABCD")).toBeInTheDocument();
  });

  it("displays players list", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("shows (you) tag next to current player", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    expect(screen.getByText("(you)")).toBeInTheDocument();
  });

  it("shows HOST badge for host player", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    expect(screen.getByText("HOST")).toBeInTheDocument();
  });

  it("shows kick buttons for other players when host", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    // There should be a kick button (×) for Bob
    const kickBtn = screen.getByTitle("Kick player");
    fireEvent.click(kickBtn);
    expect(defaultProps.onKickPlayer).toHaveBeenCalledWith("player-2");
  });

  it("does not show kick buttons when not host", () => {
    renderWithProviders(
      <LobbyScreen {...defaultProps} playerId="player-2" />
    );
    expect(screen.queryByTitle("Kick player")).not.toBeInTheDocument();
  });

  it("shows game settings for host", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    expect(screen.getByText("Game Mode")).toBeInTheDocument();
    expect(screen.getByText("Rounds")).toBeInTheDocument();
  });

  it("shows mode labels for non-host", () => {
    renderWithProviders(
      <LobbyScreen {...defaultProps} playerId="player-2" />
    );
    expect(screen.getByText("Game mode")).toBeInTheDocument();
    expect(screen.getByText("Waiting for host to start...")).toBeInTheDocument();
  });

  it("calls onChangeSettings when mode is changed", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    // Mode tile buttons include both the mode name and description in their
    // accessible name, so match by regex on the name portion.
    fireEvent.click(screen.getByRole("button", { name: /^Higher or Lower/ }));
    expect(defaultProps.onChangeSettings).toHaveBeenCalledWith({
      gameMode: "higher-lower",
    });
  });

  it("calls onChangeSettings when rounds are changed", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    expect(defaultProps.onChangeSettings).toHaveBeenCalledWith({
      totalRounds: 5,
    });
  });

  it("Start Game button is enabled with 2+ connected players", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    const startBtn = screen.getByRole("button", { name: "Start Game" });
    expect(startBtn).not.toBeDisabled();
    fireEvent.click(startBtn);
    expect(defaultProps.onStartRound).toHaveBeenCalledOnce();
  });

  it("Start Game button is disabled with fewer than 2 connected players", () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({
          players: [makePlayer({ id: "host-1", isHost: true })],
          hostPlayerId: "host-1",
        })}
      />
    );
    expect(screen.getByRole("button", { name: "Start Game" })).toBeDisabled();
    expect(screen.getByText("Need at least 2 players to start (add bots or invite friends)")).toBeInTheDocument();
  });

  it("shows Leave button and calls onLeave after confirmation", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    // MPTopBar shows a confirmation modal before firing onLeave.
    fireEvent.click(screen.getByRole("button", { name: "Leave Game" }));
    expect(defaultProps.onLeave).toHaveBeenCalledOnce();
  });

  it("shows the full invite URL in the share block", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    // Display the full join URL prominently (origin + /<code>) so users
    // can read or long-press to copy on mobile without opening a modal.
    const url = `${window.location.origin}/${defaultProps.room.code}`;
    expect(screen.getByText(url)).toBeInTheDocument();
  });

  it("copies the room URL to clipboard when Copy is clicked", async () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /copy invite link/i }));
    const expected = `${window.location.origin}/${defaultProps.room.code}`;
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected);
    // After the copy resolves, the button's visible label briefly flips to
    // "Copied!" — the aria-label stays stable for screen readers, so we
    // assert the text node directly.
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });

  it("invokes the native Web Share API when available", () => {
    const shareSpy = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share: shareSpy });
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /share invite link/i }));
    expect(shareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(defaultProps.room.code),
        url: expect.stringContaining(`/${defaultProps.room.code}`),
      }),
    );
    // Cleanup so subsequent tests run with clipboard fallback.
    delete (navigator as unknown as { share?: unknown }).share;
  });

  it("falls back to clipboard copy when Web Share is unavailable", async () => {
    // Make sure no navigator.share leaks in from a prior test
    delete (navigator as unknown as { share?: unknown }).share;
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /share invite link/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(`/${defaultProps.room.code}`),
    );
    // The fallback path surfaces a toast confirmation
    expect(await screen.findByText(/link copied/i)).toBeInTheDocument();
  });

  it("shows password badge when room has password", () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({ hasPassword: true })}
      />
    );
    expect(screen.getByText("Password Protected")).toBeInTheDocument();
  });

  it("shows disconnected badge for offline players", () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({
          players: [
            makePlayer({ id: "host-1", isHost: true }),
            makePlayer({ id: "player-2", displayName: "Bob", isConnected: false }),
          ],
          hostPlayerId: "host-1",
        })}
      />
    );
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

  it("shows error message when category fetch fails", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("Network error");
    });
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Categories" }));
    expect(await screen.findByText("Failed to load categories.")).toBeInTheDocument();
    expect(screen.queryByText("All Categories")).not.toBeInTheDocument();
  });

  it("shows category toggle button and categories panel", async () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Categories" }));
    expect(await screen.findByText("Electronics")).toBeInTheDocument();
    expect(screen.getByText("All Categories")).toBeInTheDocument();
  });

  it("toggles a category selection", async () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Categories" }));
    fireEvent.click(await screen.findByText("Electronics"));
    expect(defaultProps.onChangeSettings).toHaveBeenCalledWith({
      categories: ["Electronics"],
    });
  });

  it("removes a category when already selected", async () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({
          categories: ["Electronics", "Home & Kitchen"],
          hostPlayerId: "host-1",
          players: defaultProps.room.players,
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change Categories" }));
    fireEvent.click(await screen.findByText("Electronics"));
    expect(defaultProps.onChangeSettings).toHaveBeenCalledWith({
      categories: ["Home & Kitchen"],
    });
  });

  it("sends null categories when last category is deselected", async () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({
          categories: ["Electronics"],
          hostPlayerId: "host-1",
          players: defaultProps.room.players,
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change Categories" }));
    // Categories are checkbox inputs inside labels — target by role=checkbox
    fireEvent.click(await screen.findByRole("checkbox", { name: "Electronics" }));
    expect(defaultProps.onChangeSettings).toHaveBeenCalledWith({
      categories: null,
    });
  });

  it("selects all categories", async () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({
          categories: ["Electronics"],
          hostPlayerId: "host-1",
          players: defaultProps.room.players,
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change Categories" }));
    fireEvent.click(await screen.findByText("All Categories"));
    expect(defaultProps.onChangeSettings).toHaveBeenCalledWith({
      categories: null,
    });
  });

  it("shows password form and sets password", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Set Password" }));
    const input = screen.getByPlaceholderText("Enter room password...");
    fireEvent.change(input, { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(defaultProps.onChangeSettings).toHaveBeenCalledWith({
      password: "secret123",
    });
  });

  it("sets null password when input is empty", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Set Password" }));
    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(defaultProps.onChangeSettings).toHaveBeenCalledWith({
      password: null,
    });
  });

  it("shows Remove button when password is set", () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({
          hasPassword: true,
          hostPlayerId: "host-1",
          players: defaultProps.room.players,
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(defaultProps.onChangeSettings).toHaveBeenCalledWith({
      password: null,
    });
  });

  it("shows between-rounds standings", () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({
          status: "between_rounds",
          currentRound: 3,
          players: [
            makePlayer({ id: "host-1", displayName: "Alice", isHost: true, totalScore: 3000 }),
            makePlayer({ id: "player-2", displayName: "Bob", totalScore: 2000 }),
          ],
          hostPlayerId: "host-1",
        })}
      />
    );
    expect(screen.getByText("Standings after Round 3")).toBeInTheDocument();
    expect(screen.getByText("3,000")).toBeInTheDocument();
    expect(screen.getByText("2,000")).toBeInTheDocument();
  });

  it("shows loading state on Start Game button", () => {
    renderWithProviders(<LobbyScreen {...defaultProps} loading={true} />);
    expect(screen.getByRole("button", { name: "Starting..." })).toBeDisabled();
  });

  it("non-host sees password protected label", () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        playerId="player-2"
        room={makeRoom({ hasPassword: true })}
      />
    );
    expect(screen.getByText("Password")).toBeInTheDocument();
  });

  it("shows category count label when categories are selected", () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({ categories: ["Electronics", "Home & Kitchen"] })}
      />
    );
    expect(screen.getByText("2 categories")).toBeInTheDocument();
  });

  it("shows single category name when one is selected", () => {
    renderWithProviders(
      <LobbyScreen
        {...defaultProps}
        room={makeRoom({ categories: ["Electronics"] })}
      />
    );
    // The category label shows in the header
    const labels = screen.getAllByText("Electronics");
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });

  it("hides categories panel when toggled again", async () => {
    renderWithProviders(<LobbyScreen {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Categories" }));
    expect(await screen.findByText("All Categories")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("All Categories")).not.toBeInTheDocument();
  });
});
