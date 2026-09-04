/**
 * Tests for AdSlot — the reusable AdSense mount point.
 *
 * There is no AdSense account yet, so the component's whole job right
 * now is staying inert. These tests exercise every gate individually
 * (broadcast mode, /admin routes, advertising consent, the
 * VITE_ADS_ENABLED kill switch, and the per-slot client/slot-id env
 * vars) to prove `null` is the only possible output in the current,
 * unconfigured state, and that the gates are wired correctly for when
 * real credentials are set later.
 *
 * `SLOT_ENV_VAR` and the module-scoped `scriptInjected` flag are
 * captured at import time (same as utils/analytics.ts's
 * `GA_MEASUREMENT_ID` / `scriptInjected`), so each test stubs env vars
 * with `vi.stubEnv` and then `vi.resetModules()` before importing —
 * mirroring `__tests__/analytics.test.ts`. Because `vi.resetModules()`
 * clears the *entire* module registry, `AdSlot` and the
 * `BroadcastModeContext` it reads via `useBroadcastMode()` must be
 * re-imported together each time (`loadAdSlot()` below) — a context
 * object from a stale module instance would never match the `Provider`
 * a test wraps around it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

function setAdvertisingConsent(advertising: boolean): void {
  localStorage.setItem(
    "cookie_consent",
    JSON.stringify({ consented: true, necessary: true, analytics: false, advertising }),
  );
}

const FULLY_CONFIGURED_ENV: Record<string, string> = {
  VITE_ADS_ENABLED: "true",
  VITE_ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
  VITE_ADSENSE_SLOT_HOME: "1111111111",
  VITE_ADSENSE_SLOT_RESULT: "2222222222",
  VITE_ADSENSE_SLOT_LEADERBOARD: "3333333333",
  VITE_ADSENSE_SLOT_ANCHOR: "4444444444",
};

function stubEnv(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    vi.stubEnv(key, value);
  }
}

/**
 * Resets the module registry and re-imports AdSlot together with the
 * exact `BroadcastModeContext` instance it will read from, so a test's
 * `<BroadcastModeContext.Provider>` and AdSlot's internal
 * `useBroadcastMode()` are guaranteed to agree.
 */
async function loadAdSlot() {
  vi.resetModules();
  const [{ default: AdSlot }, { BroadcastModeContext }] = await Promise.all([
    import("./AdSlot"),
    import("../../broadcast/useBroadcastMode"),
  ]);
  return { AdSlot, BroadcastModeContext };
}

describe("AdSlot", () => {
  beforeEach(() => {
    localStorage.clear();
    document.head
      .querySelectorAll("script[src*='googlesyndication']")
      .forEach((s) => s.remove());
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders nothing when no env vars are configured (current real-world state)", async () => {
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(true);
    const { container } = render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter>
          <AdSlot slot="home_below_mode_grid" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when VITE_ADS_ENABLED is unset even if credentials are configured", async () => {
    stubEnv({
      VITE_ADSENSE_CLIENT_ID: FULLY_CONFIGURED_ENV.VITE_ADSENSE_CLIENT_ID,
      VITE_ADSENSE_SLOT_HOME: FULLY_CONFIGURED_ENV.VITE_ADSENSE_SLOT_HOME,
    });
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(true);
    const { container } = render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter>
          <AdSlot slot="home_below_mode_grid" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when VITE_ADS_ENABLED is not exactly the string "true"', async () => {
    stubEnv({ ...FULLY_CONFIGURED_ENV, VITE_ADS_ENABLED: "1" });
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(true);
    const { container } = render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter>
          <AdSlot slot="home_below_mode_grid" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing in broadcast mode even when fully configured", async () => {
    stubEnv(FULLY_CONFIGURED_ENV);
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(true);
    const { container } = render(
      <BroadcastModeContext.Provider value={true}>
        <MemoryRouter>
          <AdSlot slot="home_below_mode_grid" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing on an /admin route even when fully configured (defense in depth)", async () => {
    stubEnv(FULLY_CONFIGURED_ENV);
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(true);
    const { container } = render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter initialEntries={["/admin/dashboard"]}>
          <AdSlot slot="site_anchor_footer" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without explicit advertising-consent opt-in", async () => {
    stubEnv(FULLY_CONFIGURED_ENV);
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(false);
    const { container } = render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter>
          <AdSlot slot="home_below_mode_grid" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when consent has never been recorded (default-denied)", async () => {
    stubEnv(FULLY_CONFIGURED_ENV);
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    // no localStorage write at all — matches a fresh visitor
    const { container } = render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter>
          <AdSlot slot="home_below_mode_grid" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a slot whose own per-slot env var is unset, even when the client ID and other slots are configured", async () => {
    stubEnv({
      VITE_ADS_ENABLED: "true",
      VITE_ADSENSE_CLIENT_ID: FULLY_CONFIGURED_ENV.VITE_ADSENSE_CLIENT_ID,
      VITE_ADSENSE_SLOT_RESULT: FULLY_CONFIGURED_ENV.VITE_ADSENSE_SLOT_RESULT,
      // VITE_ADSENSE_SLOT_HOME intentionally left unset
    });
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(true);
    const { container } = render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter>
          <AdSlot slot="home_below_mode_grid" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the labeled, bordered ad container + ins mount point once every gate passes", async () => {
    stubEnv(FULLY_CONFIGURED_ENV);
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(true);
    render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter>
          <AdSlot slot="result_page_after_breakdown" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );

    const container = screen.getByTestId("ad-slot-result_page_after_breakdown");
    expect(container).toHaveClass("ad-slot", "ad-slot-result");
    expect(screen.getByText("Advertisement")).toBeInTheDocument();

    const ins = container.querySelector("ins.adsbygoogle");
    expect(ins).not.toBeNull();
    expect(ins).toHaveAttribute("data-ad-client", FULLY_CONFIGURED_ENV.VITE_ADSENSE_CLIENT_ID);
    expect(ins).toHaveAttribute("data-ad-slot", FULLY_CONFIGURED_ENV.VITE_ADSENSE_SLOT_RESULT);
    expect(ins).toHaveAttribute("data-ad-format", "auto");
    expect(ins).toHaveAttribute("data-full-width-responsive", "true");
  });

  it("injects the AdSense loader script, with the client id in the query string, once fully configured", async () => {
    stubEnv(FULLY_CONFIGURED_ENV);
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(true);
    render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter>
          <AdSlot slot="site_anchor_footer" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    const scripts = document.head.querySelectorAll<HTMLScriptElement>(
      "script[src*='pagead2.googlesyndication.com/pagead/js/adsbygoogle.js']",
    );
    expect(scripts.length).toBe(1);
    expect(scripts[0].src).toContain(`client=${FULLY_CONFIGURED_ENV.VITE_ADSENSE_CLIENT_ID}`);
    expect(scripts[0].async).toBe(true);
    expect(scripts[0].getAttribute("crossorigin")).toBe("anonymous");
  });

  it("does not inject a script when gated (unconfigured)", async () => {
    const { AdSlot, BroadcastModeContext } = await loadAdSlot();
    setAdvertisingConsent(true);
    render(
      <BroadcastModeContext.Provider value={false}>
        <MemoryRouter>
          <AdSlot slot="home_below_mode_grid" />
        </MemoryRouter>
      </BroadcastModeContext.Provider>,
    );
    expect(
      document.head.querySelectorAll("script[src*='pagead2.googlesyndication.com']").length,
    ).toBe(0);
  });
});
