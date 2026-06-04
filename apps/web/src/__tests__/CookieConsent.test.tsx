import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import CookieConsent, { openCookieSettings } from "../components/CookieConsent";

// Mock analytics module
vi.mock("../utils/analytics", () => ({
  loadGA: vi.fn(),
  grantAnalyticsConsent: vi.fn(),
  revokeAnalyticsConsent: vi.fn(),
}));

// Mock Reddit pixel module — CookieConsent wires it alongside GA
vi.mock("../utils/redditPixel", () => ({
  loadRedditPixel: vi.fn(),
  grantRedditConsent: vi.fn(),
  revokeRedditConsent: vi.fn(),
  trackRedditEvent: vi.fn(),
}));

// Mock attribution so we can assert it's only invoked after analytics consent
vi.mock("../utils/attribution", () => ({
  captureUtmFromUrl: vi.fn(),
  trackAttributionOnServer: vi.fn().mockResolvedValue(undefined),
}));

import { grantAnalyticsConsent, revokeAnalyticsConsent } from "../utils/analytics";
import { grantRedditConsent, revokeRedditConsent } from "../utils/redditPixel";
import { captureUtmFromUrl, trackAttributionOnServer } from "../utils/attribution";

function renderConsent() {
  return render(
    <BrowserRouter>
      <CookieConsent />
    </BrowserRouter>
  );
}

describe("CookieConsent", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows the banner on first visit", () => {
    renderConsent();
    expect(screen.getByText(/We use cookies for core features/)).toBeTruthy();
    expect(screen.getByText("Accept all")).toBeTruthy();
    expect(screen.getByText("Reject all")).toBeTruthy();
    expect(screen.getByText("Customise")).toBeTruthy();
  });

  it("hides the banner after accepting all", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Accept all"));
    expect(screen.queryByText(/We use cookies for core features/)).toBeNull();
    expect(grantAnalyticsConsent).toHaveBeenCalled();
  });

  it("hides the banner after rejecting all", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Reject all"));
    expect(screen.queryByText(/We use cookies for core features/)).toBeNull();
    expect(revokeAnalyticsConsent).toHaveBeenCalled();
  });

  it("Reject all persists necessary=false and analytics=false", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Reject all"));
    const saved = JSON.parse(localStorage.getItem("cookie_consent")!);
    expect(saved).toEqual({ consented: true, necessary: false, analytics: false });
  });

  it("Accept all persists necessary=true and analytics=true", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Accept all"));
    const saved = JSON.parse(localStorage.getItem("cookie_consent")!);
    expect(saved).toEqual({ consented: true, necessary: true, analytics: true });
  });

  it("Reject and Accept buttons in the banner share a sizing class", () => {
    renderConsent();
    const reject = screen.getByText("Reject all");
    const accept = screen.getByText("Accept all");
    expect(reject.className).toContain("cookie-btn-choice");
    expect(accept.className).toContain("cookie-btn-choice");
  });

  it("does not show the banner when consent was previously given", () => {
    localStorage.setItem(
      "cookie_consent",
      JSON.stringify({ consented: true, necessary: true, analytics: false }),
    );
    renderConsent();
    expect(screen.queryByText(/We use cookies for core features/)).toBeNull();
  });

  it("opens settings modal when clicking Customise", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));
    expect(screen.getByText("Cookie settings")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("settings modal has aria-modal and aria-labelledby", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("cookie-modal-heading");
  });

  it("close button has aria-label", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });

  it("analytics toggle has aria-label", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));
    expect(screen.getByLabelText("Enable analytics cookies")).toBeTruthy();
  });

  it("necessary toggle is present and defaults on", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));
    const toggle = screen.getByLabelText("Enable necessary cookies") as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(true);
  });

  it("settings modal descriptions don't leak technical cookie names", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));
    const dialog = screen.getByRole("dialog");
    const body = dialog.textContent ?? "";
    expect(body).not.toMatch(/visitor_id/);
    expect(body).not.toMatch(/pg_ev_buf/);
    expect(body).not.toMatch(/utm_attribution/);
    expect(body).not.toMatch(/_rdt/);
    expect(body).not.toMatch(/_ga/);
    expect(body).not.toMatch(/HttpOnly/);
  });

  it("toggling Necessary off and saving persists necessary=false", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));

    const toggle = screen.getByLabelText("Enable necessary cookies") as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);

    fireEvent.click(screen.getByText("Save preferences"));

    const saved = JSON.parse(localStorage.getItem("cookie_consent")!);
    expect(saved).toEqual({ consented: true, necessary: false, analytics: false });
  });

  it("closes modal on Escape key", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));
    expect(screen.getByText("Cookie settings")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Cookie settings")).toBeNull();
  });

  it("saves toggled analytics preference via Save preferences", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));

    const toggle = screen.getByLabelText("Enable analytics cookies") as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);

    fireEvent.click(screen.getByText("Save preferences"));

    const saved = JSON.parse(localStorage.getItem("cookie_consent")!);
    expect(saved).toEqual({ consented: true, necessary: true, analytics: true });
  });

  it("Accept all from modal enables analytics", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Customise"));
    fireEvent.click(screen.getAllByText("Accept all")[0]);

    const saved = JSON.parse(localStorage.getItem("cookie_consent")!);
    expect(saved).toEqual({ consented: true, necessary: true, analytics: true });
    expect(grantAnalyticsConsent).toHaveBeenCalled();
  });

  it("responds to open-cookie-settings custom event", () => {
    localStorage.setItem(
      "cookie_consent",
      JSON.stringify({ consented: true, necessary: true, analytics: false }),
    );
    renderConsent();

    expect(screen.queryByText("Cookie settings")).toBeNull();

    act(() => {
      openCookieSettings();
    });

    expect(screen.getByText("Cookie settings")).toBeTruthy();
  });

  it("banner has role=region, not role=dialog", () => {
    renderConsent();
    const banner = screen.getByRole("region");
    expect(banner.getAttribute("aria-label")).toBe("Cookie consent");
  });

  // ── Reddit Pixel consent wiring ─────────────────────────────────────

  it("grants Reddit consent alongside GA when user accepts all", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Accept all"));
    expect(grantRedditConsent).toHaveBeenCalled();
  });

  it("revokes Reddit consent alongside GA when user rejects all", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Reject all"));
    expect(revokeRedditConsent).toHaveBeenCalled();
  });

  it("revokes Reddit consent when returning user has analytics disabled", () => {
    localStorage.setItem(
      "cookie_consent",
      JSON.stringify({ consented: true, necessary: true, analytics: false }),
    );
    renderConsent();
    expect(revokeRedditConsent).toHaveBeenCalled();
  });

  it("grants Reddit consent when returning user has analytics enabled", () => {
    localStorage.setItem(
      "cookie_consent",
      JSON.stringify({ consented: true, necessary: true, analytics: true }),
    );
    renderConsent();
    expect(grantRedditConsent).toHaveBeenCalled();
  });

  // ── UTM / attribution capture gated on consent ──────────────────────

  it("does not capture UTM attribution when user rejects all", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Reject all"));
    expect(captureUtmFromUrl).not.toHaveBeenCalled();
    expect(trackAttributionOnServer).not.toHaveBeenCalled();
  });

  it("captures UTM attribution when user accepts all", () => {
    renderConsent();
    fireEvent.click(screen.getByText("Accept all"));
    expect(captureUtmFromUrl).toHaveBeenCalled();
    expect(trackAttributionOnServer).toHaveBeenCalled();
  });

  it("does not capture UTM attribution before user decides", () => {
    renderConsent();
    expect(captureUtmFromUrl).not.toHaveBeenCalled();
    expect(trackAttributionOnServer).not.toHaveBeenCalled();
  });
});
