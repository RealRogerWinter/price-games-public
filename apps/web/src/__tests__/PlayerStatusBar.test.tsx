import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PlayerStatusBar from "../components/multiplayer/PlayerStatusBar";
import { makePlayer } from "./testUtils";

describe("PlayerStatusBar", () => {
  const players = [
    makePlayer({ id: "p1", displayName: "Alice", avatar: "wizard", totalScore: 500 }),
    makePlayer({ id: "p2", displayName: "Bob", avatar: "yeti", totalScore: 300 }),
    makePlayer({ id: "p3", displayName: "Charlie", avatar: "fancy-ghost", isConnected: false, totalScore: 100 }),
  ];

  it("renders all player names", () => {
    render(
      <PlayerStatusBar players={players} lockedPlayerIds={new Set()} currentPlayerId="p1" />
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("Charlie")).toBeInTheDocument();
  });

  it("renders player scores", () => {
    render(
      <PlayerStatusBar players={players} lockedPlayerIds={new Set()} currentPlayerId="p1" />
    );
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
  });

  it("marks locked players with check mark and locked class", () => {
    const { container } = render(
      <PlayerStatusBar
        players={players}
        lockedPlayerIds={new Set(["p1"])}
        currentPlayerId="p2"
      />
    );
    const lockedItems = container.querySelectorAll(".player-status-item.locked");
    expect(lockedItems.length).toBe(1);
    expect(screen.getByText("\u2713")).toBeInTheDocument();
  });

  it("marks offline players", () => {
    const { container } = render(
      <PlayerStatusBar players={players} lockedPlayerIds={new Set()} currentPlayerId="p1" />
    );
    const offlineItems = container.querySelectorAll(".player-status-item.offline");
    expect(offlineItems.length).toBe(1);
  });

  it("marks the current player with is-you class", () => {
    const { container } = render(
      <PlayerStatusBar players={players} lockedPlayerIds={new Set()} currentPlayerId="p2" />
    );
    const youItems = container.querySelectorAll(".player-status-item.is-you");
    expect(youItems.length).toBe(1);
  });

  it("renders correct number of avatar icons", () => {
    const { container } = render(
      <PlayerStatusBar players={players} lockedPlayerIds={new Set()} currentPlayerId="p1" />
    );
    const avatars = container.querySelectorAll(".avatar-icon");
    expect(avatars.length).toBe(3);
  });
});
