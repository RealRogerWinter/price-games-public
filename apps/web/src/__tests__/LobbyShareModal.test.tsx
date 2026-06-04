/**
 * Tests for LobbyShareModal — replaces the lobby's plain "Copy Invite Link"
 * button with a richer share sheet (native share / copy link / QR / copy
 * room code). Mints an invite token on first render so the share URL
 * carries the inviter attribution.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders } from "./testUtils";
import { fireEvent, screen, waitFor, act } from "@testing-library/react";
import LobbyShareModal from "../components/multiplayer/LobbyShareModal";

vi.mock("../api/client", () => ({
  mintInviteToken: vi.fn(),
}));
vi.mock("qrcode", () => ({
  default: { toCanvas: vi.fn().mockResolvedValue(undefined) },
  toCanvas: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../analytics/useTrackEvent", () => ({
  useTrackEvent: () => trackMock,
}));

const trackMock = vi.fn();

import { mintInviteToken } from "../api/client";
const mintMock = mintInviteToken as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  trackMock.mockReset();
  mintMock.mockReset();
  mintMock.mockResolvedValue({
    token: "abc1234567",
    url: "https://test.local/r/abc1234567",
  });
});

describe("LobbyShareModal", () => {
  it("renders the room code and a Copy Link button when open", async () => {
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
      />,
    );
    // Room code shown prominently
    expect(screen.getByText("ABCD")).toBeInTheDocument();
    // Copy Link button always visible
    expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument();
    await waitFor(() => expect(mintMock).toHaveBeenCalledWith("ABCD", "player-1"));
  });

  it("returns null when not open", () => {
    const { container } = renderWithProviders(
      <LobbyShareModal
        open={false}
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("invokes onClose when ESC is pressed", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={onClose}
        roomCode="ABCD"
        playerToken="player-1"
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("copies the minted invite URL to clipboard when Copy Link is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
      />,
    );
    // Wait for the mint to settle so the URL is the tokenized form.
    await waitFor(() => expect(mintMock).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy link/i }));
    });
    expect(writeText).toHaveBeenCalledWith("https://test.local/r/abc1234567");
  });

  it("falls back to /<roomCode> if the mint fails", async () => {
    mintMock.mockRejectedValue(new Error("server down"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, origin: "https://test.local" },
    });
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="WXYZ"
        playerToken="player-1"
      />,
    );
    await waitFor(() => expect(mintMock).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy link/i }));
    });
    // Falls back to plain code-only URL.
    expect(writeText).toHaveBeenCalledWith("https://test.local/WXYZ");
  });

  it("renders a 'Share…' button only when navigator.share exists", async () => {
    Object.assign(navigator, { share: vi.fn().mockResolvedValue(undefined) });
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
      />,
    );
    expect(screen.getByRole("button", { name: /share…|share$/i })).toBeInTheDocument();
  });

  it("renders the QR code container with a canvas", () => {
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
      />,
    );
    expect(screen.getByTestId("lobby-share-qr")).toBeInTheDocument();
  });

  // Analytics: share_clicked must fire ONLY on confirmed copy/share success,
  // not on a thrown clipboard rejection. The `.then` placement of the emit
  // is the load-bearing detail; if it moves into `.catch` or runs
  // unconditionally the share-link funnel in v2 will be wrong.
  it("emits share_clicked on copy-link success with role/method/has_invite_token", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
        gameMode="classic"
        isHost
      />,
    );
    await waitFor(() => expect(mintMock).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy link/i }));
    });
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "share_clicked",
        category: "mp",
        properties: expect.objectContaining({
          room_code: "ABCD",
          game_mode: "classic",
          role: "host",
          method: "modal_copy",
          has_invite_token: true,
        }),
      }),
    );
  });

  it("does NOT emit share_clicked when clipboard.writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
        gameMode="classic"
      />,
    );
    await waitFor(() => expect(mintMock).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy link/i }));
    });
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("emits share_clicked with method='modal_copy_code' for the room-code button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
        gameMode="bidding"
        isHost={false}
      />,
    );
    await waitFor(() => expect(mintMock).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy room code only/i }));
    });
    expect(trackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          method: "modal_copy_code",
          role: "player",
          game_mode: "bidding",
        }),
      }),
    );
  });

  it("emits share_clicked with method='modal_native_share' on native share success", async () => {
    const shareFn = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share: shareFn });
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
        gameMode="classic"
        isHost
      />,
    );
    await waitFor(() => expect(mintMock).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /share…|share$/i }));
    });
    expect(trackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ method: "modal_native_share" }),
      }),
    );
  });

  it("does NOT emit share_clicked when navigator.share rejects (user cancelled)", async () => {
    const shareFn = vi.fn().mockRejectedValue(new Error("AbortError"));
    Object.assign(navigator, { share: shareFn });
    renderWithProviders(
      <LobbyShareModal
        open
        onClose={vi.fn()}
        roomCode="ABCD"
        playerToken="player-1"
      />,
    );
    await waitFor(() => expect(mintMock).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /share…|share$/i }));
    });
    expect(trackMock).not.toHaveBeenCalled();
  });
});
