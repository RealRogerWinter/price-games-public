import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ShareGridInput, SharedRoundSnapshot } from "@price-game/shared";
import ShareModal from "../components/share/ShareModal";
import { CurrencyProvider } from "../context/CurrencyContext";
import * as api from "../api/client";

/**
 * ShareModal now consumes the currency context (for formatPrice in the
 * per-round breakdown), so every render in this file must be wrapped in
 * CurrencyProvider or the component throws at mount. Using a thin helper
 * lets us keep the existing test assertions unchanged.
 */
function renderModal(ui: ReactElement) {
  return render(<CurrencyProvider>{ui}</CurrencyProvider>);
}

// Mock the API client so ShareModal's on-mount POST is inspectable and
// deterministic. Individual tests override the resolved value or toggle a
// rejection to exercise the silent-fallback path.
vi.mock("../api/client", () => ({
  createShare: vi.fn(),
  getShare: vi.fn(),
}));
const mockedApi = vi.mocked(api);

function makeSnapshots(count = 10): SharedRoundSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    roundNumber: i + 1,
    score: 1000,
    products: [
      {
        title: `Product ${i + 1}`,
        imageUrl: "https://example.com/p.jpg",
        priceCents: 2500,
      },
    ],
  }));
}

function makeShareInput(overrides: Partial<ShareGridInput> = {}): ShareGridInput {
  return {
    gameMode: "classic",
    modeName: "Precision",
    roundScores: [1000, 1000, 750, 1000, 0, 500, 1000, 1000, 300, 950],
    totalScore: 7500,
    perRoundMax: 1000,
    ...overrides,
  };
}

function setNavigatorClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    writable: true,
    configurable: true,
  });
}

function setNavigatorShare(fn: unknown) {
  Object.defineProperty(navigator, "share", {
    value: fn,
    writable: true,
    configurable: true,
  });
}

describe("ShareModal", () => {
  let originalClipboard: PropertyDescriptor | undefined;
  let originalShare: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
    // Default: createShare returns a stub URL. Tests without roundSnapshots
    // never trigger this; tests with snapshots can override per-test.
    // Clear history explicitly — vitest's restoreMocks only affects vi.spyOn
    // mocks, not the vi.fn()s inside a vi.mock factory.
    mockedApi.createShare.mockClear();
    mockedApi.createShare.mockResolvedValue({ id: "testsha1", url: "/s/testsha1" });
  });

  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    if (originalShare) {
      Object.defineProperty(navigator, "share", originalShare);
    } else {
      Object.defineProperty(navigator, "share", {
        value: undefined,
        writable: true,
        configurable: true,
      });
    }
  });

  it("renders the dialog with role and aria-modal attributes", () => {
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Share your results");
  });

  it("renders the emoji grid text preview", () => {
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    const pre = screen.getByText(/Price Games \| Precision \| 7,500\/10,000/);
    expect(pre).toBeInTheDocument();
    // Grid tiles should be present in the pre element.
    expect(pre.textContent).toContain("🟩");
    expect(pre.textContent).toContain("⬛");
  });

  it("renders an accessible description for screen readers", () => {
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    expect(
      screen.getByText(/Score 7,500 of 10,000/)
    ).toBeInTheDocument();
  });

  it("closes when the overlay is clicked", () => {
    const onClose = vi.fn();
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("share-modal-overlay"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when the content is clicked (stopPropagation)", () => {
    const onClose = vi.fn();
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={onClose} />);
    fireEvent.click(screen.getByText("Share your results"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape key", () => {
    const onClose = vi.fn();
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when the close button is clicked", () => {
    const onClose = vi.fn();
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe("inline copy icon on the text preview", () => {
    it("renders a copy-text icon button inside the text preview when clipboard text is supported", () => {
      renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
      const icon = screen.getByLabelText("Copy share text");
      expect(icon).toBeInTheDocument();
      // Should live inside the text preview container, not the action row.
      const textPreview = icon.closest(".share-modal-text-preview");
      expect(textPreview).not.toBeNull();
    });

    it("hides the copy-text icon when the Clipboard API is unavailable", () => {
      Object.defineProperty(navigator, "clipboard", {
        value: undefined,
        writable: true,
        configurable: true,
      });
      renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
      expect(screen.queryByLabelText("Copy share text")).not.toBeInTheDocument();
    });

    it("copies the share text when the icon is clicked", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText, write: vi.fn() },
        writable: true,
        configurable: true,
      });
      renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
      fireEvent.click(screen.getByLabelText("Copy share text"));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalled();
      });
      expect(writeText.mock.calls[0][0]).toContain("Price Games | Precision");
      expect(screen.getByText("Text copied!")).toBeInTheDocument();
    });
  });

  it("renders the PNG preview image once renderShareImage resolves", async () => {
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    const img = await screen.findByAltText("Price Games share card");
    expect(img).toHaveAttribute("src", expect.stringContaining("blob:"));
  });

  it("calls navigator.clipboard.writeText when Copy Text is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigatorClipboard({ writeText });
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Copy Text"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    expect(writeText.mock.calls[0][0]).toContain("Price Games | Precision");
    expect(screen.getByText("Text copied!")).toBeInTheDocument();
  });

  it("shows an error status when copy text fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setNavigatorClipboard({ writeText });
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Copy Text"));
    await waitFor(() => {
      expect(screen.getByText("denied")).toBeInTheDocument();
    });
  });

  it("hides Copy Text when the API is unavailable", () => {
    setNavigatorClipboard(undefined);
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    expect(screen.queryByText("Copy Text")).not.toBeInTheDocument();
  });

  it("shows Copy Image when clipboard.write is available and image rendered", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    setNavigatorClipboard({ writeText: vi.fn(), write });
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    // Wait for the image to render (sets imageBlob, which gates the button).
    const button = await screen.findByText("Copy Image");
    fireEvent.click(button);
    await waitFor(() => {
      expect(write).toHaveBeenCalled();
    });
    expect(screen.getByText("Image copied!")).toBeInTheDocument();
  });

  it("hides Copy Image when clipboard.write is unavailable", async () => {
    setNavigatorClipboard({ writeText: vi.fn() });
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    // Even after image renders, button should not appear.
    await screen.findByAltText("Price Games share card");
    expect(screen.queryByText("Copy Image")).not.toBeInTheDocument();
  });

  it("shows Share button when navigator.share is available and invokes it", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigatorShare(share);
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    const button = screen.getByText("Share…");
    fireEvent.click(button);
    await waitFor(() => {
      expect(share).toHaveBeenCalled();
    });
    const payload = share.mock.calls[0][0];
    expect(payload.title).toBe("Price Games");
    expect(payload.text).toContain("Price Games |");
  });

  it("hides Share button when navigator.share is unavailable", () => {
    setNavigatorShare(undefined);
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    expect(screen.queryByText("Share…")).not.toBeInTheDocument();
  });

  it("renders Download Image once the blob is ready and triggers a download", async () => {
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    const downloadBtn = await screen.findByText("Download Image");
    // Clicking should not throw; status should flip to success.
    fireEvent.click(downloadBtn);
    expect(screen.getByText("Image downloaded!")).toBeInTheDocument();
  });

  it("shows the image error message when renderShareImage rejects", async () => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error force null
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
    try {
      renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
      expect(
        await screen.findByText(/Could not render share card/)
      ).toBeInTheDocument();
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  it("auto-focuses the close button on mount for keyboard users", () => {
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Close")).toHaveFocus();
  });

  it("places the dialog role on the content container, not the overlay", () => {
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("share-modal-content");
    const overlay = screen.getByTestId("share-modal-overlay");
    expect(overlay).not.toHaveAttribute("role", "dialog");
  });

  it("traps Tab focus inside the modal (wraps from last to first)", async () => {
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    // Wait for the image to render so all action buttons are mounted.
    await screen.findByAltText("Price Games share card");
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>("button");
    expect(focusables.length).toBeGreaterThan(1);
    const last = focusables[focusables.length - 1];
    last.focus();
    expect(last).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(focusables[0]).toHaveFocus();
  });

  it("traps Shift-Tab focus inside the modal (wraps from first to last)", async () => {
    renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
    await screen.findByAltText("Price Games share card");
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>("button");
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  describe("Shareable URL (Phase 2)", () => {
    it("does not POST to /api/share when roundSnapshots is omitted", () => {
      renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
      expect(mockedApi.createShare).not.toHaveBeenCalled();
    });

    it("does not POST when roundSnapshots is an empty array", () => {
      renderModal(
        <ShareModal
          shareInput={makeShareInput()}
          roundSnapshots={[]}
          onClose={vi.fn()}
        />
      );
      expect(mockedApi.createShare).not.toHaveBeenCalled();
    });

    it("POSTs to /api/share on mount when roundSnapshots is provided", async () => {
      renderModal(
        <ShareModal
          shareInput={makeShareInput()}
          roundSnapshots={makeSnapshots()}
          playerName="Alice"
          onClose={vi.fn()}
        />
      );
      await waitFor(() => {
        expect(mockedApi.createShare).toHaveBeenCalledTimes(1);
      });
      const payload = mockedApi.createShare.mock.calls[0][0];
      expect(payload.gameMode).toBe("classic");
      expect(payload.totalScore).toBe(7500);
      expect(payload.perRoundMax).toBe(1000);
      expect(payload.playerName).toBe("Alice");
      expect(payload.roundData).toHaveLength(10);
    });

    it("updates the text footer with the returned short URL once the POST resolves", async () => {
      mockedApi.createShare.mockResolvedValue({ id: "aBcD1234", url: "/s/aBcD1234" });
      renderModal(
        <ShareModal
          shareInput={makeShareInput()}
          roundSnapshots={makeSnapshots()}
          onClose={vi.fn()}
        />
      );
      await waitFor(() => {
        // Footer should contain the URL path (with the jsdom host).
        expect(screen.getByText((content) => content.includes("/s/aBcD1234"))).toBeInTheDocument();
      });
      // And the default fallback "play at price.games" should no longer be present.
      expect(screen.queryByText(/play at price\.games/)).not.toBeInTheDocument();
    });

    it("silently falls back to the default footer when POST rejects", async () => {
      mockedApi.createShare.mockRejectedValue(new Error("network down"));
      renderModal(
        <ShareModal
          shareInput={makeShareInput()}
          roundSnapshots={makeSnapshots()}
          onClose={vi.fn()}
        />
      );
      await waitFor(() => {
        expect(mockedApi.createShare).toHaveBeenCalled();
      });
      // Default footer should still be visible after the rejection.
      expect(screen.getByText((content) => content.includes("play at price.games"))).toBeInTheDocument();
      // No user-visible error status.
      expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
    });

    it("renders the public-link advisory caption when roundSnapshots is provided", () => {
      renderModal(
        <ShareModal
          shareInput={makeShareInput()}
          roundSnapshots={makeSnapshots()}
          onClose={vi.fn()}
        />
      );
      expect(screen.getByText(/Share links are public/i)).toBeInTheDocument();
    });

    it("omits the advisory caption when roundSnapshots is not provided", () => {
      renderModal(<ShareModal shareInput={makeShareInput()} onClose={vi.fn()} />);
      expect(screen.queryByText(/Share links are public/i)).not.toBeInTheDocument();
    });

    it("shows the Copy Link button after the short URL resolves", async () => {
      renderModal(
        <ShareModal
          shareInput={makeShareInput()}
          roundSnapshots={makeSnapshots()}
          onClose={vi.fn()}
        />
      );
      // Button is hidden until shareUrl resolves.
      expect(screen.queryByText("Copy Link")).not.toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText("Copy Link")).toBeInTheDocument();
      });
    });

    it("Copy Link copies the absolute URL to the clipboard", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText, write: vi.fn() },
        writable: true,
        configurable: true,
      });
      mockedApi.createShare.mockResolvedValue({ id: "xYz99999", url: "/s/xYz99999" });
      renderModal(
        <ShareModal
          shareInput={makeShareInput()}
          roundSnapshots={makeSnapshots()}
          onClose={vi.fn()}
        />
      );
      const button = await screen.findByText("Copy Link");
      fireEvent.click(button);
      await waitFor(() => {
        expect(writeText).toHaveBeenCalled();
      });
      const copied = writeText.mock.calls[0][0] as string;
      expect(copied).toContain("/s/xYz99999");
      expect(copied).toMatch(/^https?:\/\//);
      expect(screen.getByText("Link copied!")).toBeInTheDocument();
    });

    it("passes null playerName when not provided", async () => {
      renderModal(
        <ShareModal
          shareInput={makeShareInput()}
          roundSnapshots={makeSnapshots()}
          onClose={vi.fn()}
        />
      );
      await waitFor(() => {
        expect(mockedApi.createShare).toHaveBeenCalled();
      });
      expect(mockedApi.createShare.mock.calls[0][0].playerName).toBeNull();
    });
  });
});
