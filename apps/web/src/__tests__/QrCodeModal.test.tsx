/**
 * Tests for QrCodeModal — rendering, short-URL vs. long-URL fallback,
 * PNG/SVG download buttons, and close handling.
 *
 * The `qrcode` package is mocked so the test does not depend on jsdom's
 * canvas implementation (which is not wired up in this project's vitest
 * config).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { AdminUtmTag } from "../api/adminClient";

// Mock the qrcode package up front so the component under test picks up the
// mock when it imports `qrcode`.
const toCanvasMock = vi.fn(async (_canvas: HTMLCanvasElement, _text: string) => {});
const toStringMock = vi.fn(
  async (_text: string, _opts: { type: "svg" }) =>
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>',
);

vi.mock("qrcode", () => ({
  default: {
    toCanvas: (...args: unknown[]) => toCanvasMock(...(args as [HTMLCanvasElement, string])),
    toString: (...args: unknown[]) => toStringMock(...(args as [string, { type: "svg" }])),
  },
  toCanvas: (...args: unknown[]) => toCanvasMock(...(args as [HTMLCanvasElement, string])),
  toString: (...args: unknown[]) => toStringMock(...(args as [string, { type: "svg" }])),
}));

import QrCodeModal from "../pages/admin/QrCodeModal";

const sampleTag: AdminUtmTag = {
  id: "t-1",
  name: "reddit-gw-v1",
  utmSource: "reddit",
  utmMedium: "cpc",
  utmCampaign: "giveaway_v1",
  utmContent: null,
  utmTerm: null,
  destinationUrl: "/giveaway",
  status: "active",
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-01T00:00:00Z",
  createdBy: "admin-1",
  shortCode: null,
  clickCount: 0,
  lastClickedAt: null,
};

describe("QrCodeModal", () => {
  let originalOrigin: string;

  beforeEach(() => {
    toCanvasMock.mockClear();
    toStringMock.mockClear();
    // Stub window.location.origin to a Tailscale-like host. The QR code
    // helper must IGNORE this and encode the canonical public origin
    // (https://price.games), otherwise admins on Tailscale would generate
    // QR codes that point to a host the public can't reach.
    originalOrigin = window.location.origin;
    Object.defineProperty(window, "location", {
      value: { ...window.location, origin: "https://admin-panel.tailnet.ts.net" },
      writable: true,
    });
    // jsdom does not provide HTMLCanvasElement.prototype.toDataURL by default.
    HTMLCanvasElement.prototype.toDataURL = vi
      .fn()
      .mockReturnValue("data:image/png;base64,iVBORw0KG");
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: { ...window.location, origin: originalOrigin },
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("renders the modal with the short URL when the tag has a short code", async () => {
    render(
      <QrCodeModal
        tag={{ ...sampleTag, shortCode: "reddit-gw-1" }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(toCanvasMock).toHaveBeenCalled();
    });
    // The QR target URL must be the canonical public origin, NOT the
    // Tailscale window.location.origin we stubbed above.
    const calledWith = toCanvasMock.mock.calls[0][1];
    expect(calledWith).toBe("https://price.games/go/reddit-gw-1");
    expect(calledWith).not.toContain("ts.net");
    // Visible URL string in the modal.
    expect(screen.getByTestId("qr-modal-url")).toHaveTextContent(
      "https://price.games/go/reddit-gw-1",
    );
  });

  it("falls back to the long UTM URL when the tag has no short code", async () => {
    render(<QrCodeModal tag={sampleTag} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(toCanvasMock).toHaveBeenCalled();
    });
    const calledWith = toCanvasMock.mock.calls[0][1];
    // The encoded URL must use the canonical public origin, ignoring the
    // Tailscale host we stubbed above.
    expect(calledWith).toMatch(/^https:\/\/price\.games\/giveaway/);
    expect(calledWith).not.toContain("ts.net");
    expect(calledWith).toContain("utm_source=reddit");
    expect(calledWith).toContain("utm_medium=cpc");
    expect(calledWith).toContain("utm_campaign=giveaway_v1");
  });

  it("downloads a PNG when Download PNG is clicked", async () => {
    // Capture the anchor click so we can assert it was triggered.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(
      <QrCodeModal
        tag={{ ...sampleTag, shortCode: "png-tag" }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(toCanvasMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("qr-modal-download-png"));
    expect(
      (HTMLCanvasElement.prototype.toDataURL as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBeGreaterThan(0);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("downloads an SVG when Download SVG is clicked", async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    // Provide a stub URL.createObjectURL/revokeObjectURL since jsdom omits them.
    const createObjectURL = vi.fn().mockReturnValue("blob:fake-url");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    render(
      <QrCodeModal
        tag={{ ...sampleTag, shortCode: "svg-tag" }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(toCanvasMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("qr-modal-download-svg"));

    await waitFor(() => {
      expect(toStringMock).toHaveBeenCalled();
    });
    const [, opts] = toStringMock.mock.calls[0];
    expect(opts).toEqual(expect.objectContaining({ type: "svg" }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
  });

  it("calls onClose when the Close button is clicked", async () => {
    const onClose = vi.fn();
    render(
      <QrCodeModal
        tag={{ ...sampleTag, shortCode: "close-tag" }}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(toCanvasMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("qr-modal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the modal overlay is clicked", async () => {
    const onClose = vi.fn();
    render(
      <QrCodeModal
        tag={{ ...sampleTag, shortCode: "overlay-tag" }}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(toCanvasMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("qr-modal-overlay"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
