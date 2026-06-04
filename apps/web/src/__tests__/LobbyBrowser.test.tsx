import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import LobbyBrowser from "../components/multiplayer/LobbyBrowser";
import type { PublicLobbyEntry } from "@price-game/shared";

vi.mock("../api/socket", () => ({
  getPlayerSession: () => null,
}));

function makeLobby(overrides: Partial<PublicLobbyEntry> = {}): PublicLobbyEntry {
  return {
    code: "ABCD",
    gameMode: "classic",
    hostName: "Host",
    hostAvatar: "wizard",
    humanCount: 1,
    botCount: 0,
    maxPlayers: 4,
    totalRounds: 5,
    hasPassword: false,
    ...overrides,
  } as PublicLobbyEntry;
}

beforeEach(() => {
  // Default fetch mock — overridden per-test when needed.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ lobbies: [] }),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("LobbyBrowser — password prompt", () => {
  async function renderWithLobbies(lobbies: PublicLobbyEntry[]) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lobbies }),
    });
    const onJoinRoom = vi.fn();
    render(<LobbyBrowser onJoinRoom={onJoinRoom} />);
    // Wait for the lobby to render — the table updates after the first
    // fetch resolves, which happens microtask-ish so this awaits.
    await waitFor(() => {
      expect(screen.getByText(/Classic|Higher.Lower|Bidding/i)).toBeInTheDocument();
    });
    return { onJoinRoom };
  }

  it("joins immediately when the lobby has no password", async () => {
    const { onJoinRoom } = await renderWithLobbies([
      makeLobby({ code: "OPEN", hasPassword: false }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /join/i }));
    expect(onJoinRoom).toHaveBeenCalledWith("OPEN");
  });

  it("opens the password prompt instead of joining when hasPassword=true", async () => {
    const { onJoinRoom } = await renderWithLobbies([
      makeLobby({ code: "LOCK", hasPassword: true }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /join/i }));
    expect(onJoinRoom).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /password/i })).toBeInTheDocument();
    expect(screen.getByTestId("sb-pw-input")).toBeInTheDocument();
  });

  it("forwards the entered password through onJoinRoom on submit", async () => {
    const { onJoinRoom } = await renderWithLobbies([
      makeLobby({ code: "LOCK", hasPassword: true }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /join/i }));
    const dialog = screen.getByRole("dialog", { name: /password/i });
    const input = screen.getByTestId("sb-pw-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hunter2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^join$/i }));
    expect(onJoinRoom).toHaveBeenCalledWith("LOCK", "hunter2");
  });

  it("shows an inline error and does not call onJoinRoom when password is empty", async () => {
    const { onJoinRoom } = await renderWithLobbies([
      makeLobby({ code: "LOCK", hasPassword: true }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /join/i }));
    const dialog = screen.getByRole("dialog", { name: /password/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^join$/i }));
    expect(onJoinRoom).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter the room password/i)).toBeInTheDocument();
  });

  it("Cancel button closes the prompt and clears the input", async () => {
    await renderWithLobbies([makeLobby({ code: "LOCK", hasPassword: true })]);
    fireEvent.click(screen.getByRole("button", { name: /join/i }));
    const dialog = screen.getByRole("dialog", { name: /password/i });
    const input = screen.getByTestId("sb-pw-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "secret" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog", { name: /password/i })).not.toBeInTheDocument();
    // Re-open: input should be empty (cleared on cancel)
    fireEvent.click(screen.getByRole("button", { name: /join/i }));
    expect((screen.getByTestId("sb-pw-input") as HTMLInputElement).value).toBe("");
  });

  it("ESC closes only the password prompt (stops propagation to outer modal)", async () => {
    await renderWithLobbies([makeLobby({ code: "LOCK", hasPassword: true })]);
    // Outer ESC handler stand-in — bubble-phase listener that fires
    // when ESC bubbles up. The capture-phase handler inside
    // LobbyBrowser should stopPropagation, so this should NOT fire.
    const outerEscSpy = vi.fn();
    const outerHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") outerEscSpy();
    };
    document.addEventListener("keydown", outerHandler);

    fireEvent.click(screen.getByRole("button", { name: /join/i }));
    expect(screen.getByRole("dialog", { name: /password/i })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: /password/i })).not.toBeInTheDocument();
    expect(outerEscSpy).not.toHaveBeenCalled();

    document.removeEventListener("keydown", outerHandler);
  });

  it("password input has autoComplete=off so credential managers don't capture it", async () => {
    await renderWithLobbies([makeLobby({ code: "LOCK", hasPassword: true })]);
    fireEvent.click(screen.getByRole("button", { name: /join/i }));
    const input = screen.getByTestId("sb-pw-input");
    expect(input.getAttribute("autocomplete")).toBe("off");
  });

  it("renders the lock icon next to password-protected lobbies in the host cell", async () => {
    await renderWithLobbies([
      makeLobby({ code: "OPEN", hostName: "Open Host", hasPassword: false }),
      makeLobby({ code: "LOCK", hostName: "Locked Host", hasPassword: true }),
    ]);
    // The lock indicator is an aria-labelled span next to the host name.
    expect(screen.getByLabelText(/password protected/i)).toBeInTheDocument();
  });
});
