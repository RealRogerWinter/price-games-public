/**
 * AdSlot — reusable Google AdSense ad-unit mount point.
 *
 * INERT BY DESIGN: there is no AdSense account yet (publisher ID, ad-unit
 * slot IDs, ads.txt, and the EU consent-message config are all a MANUAL
 * follow-up step for the human operator). This component renders nothing
 * and loads no external script until every gate below passes — right now
 * none of the required env vars are set, so AdSlot is a no-op everywhere
 * it's mounted. The gates are written correctly ahead of time so flipping
 * on `VITE_ADS_ENABLED` + real credentials later requires no code change.
 *
 * Gates, in order:
 *  1. Not broadcast mode — the 24/7 Twitch capture stage (BroadcastShell)
 *     must never show a live ad. `useBroadcastMode()` is context-based
 *     (seeded once by BroadcastShell), so this is safe to call from a
 *     component that first mounts on a route reached mid-broadcast via
 *     `window.__pgBroadcastNav`.
 *  2. Not an /admin route — defense in depth. No admin page currently
 *     renders AdSlot, but this keeps the invariant true even if one did.
 *  3. Explicit "advertising" cookie-consent opt-in (Consent Mode v2) —
 *     required before any ad request may fire for EEA/UK visitors.
 *  4. VITE_ADS_ENABLED === "true" — a master kill switch, independent of
 *     whether credentials are configured, so ads can be paused site-wide
 *     without touching the per-slot env vars.
 *  5. Both VITE_ADSENSE_CLIENT_ID and this slot's own
 *     VITE_ADSENSE_SLOT_<NAME> env var must be non-empty strings.
 *
 * Every mounted slot always renders inside a bordered `.ad-slot` container
 * with a visible "Advertisement" label — never bare next to real game UI
 * — per a review finding that an earlier draft placed an unlabeled ad
 * directly above the site's highest-traffic tap target.
 */
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useBroadcastMode } from "../../broadcast/useBroadcastMode";
import { useConsentPreferences } from "../../utils/cookieConsent";
import "../../styles/adSlot.css";

export type AdSlotName =
  | "home_below_mode_grid"
  | "result_page_after_breakdown"
  | "leaderboard_below_table"
  | "site_anchor_footer";

interface AdSlotProps {
  slot: AdSlotName;
}

/**
 * Per-slot AdSense ad-unit ID. Each real placement gets its own ad-unit
 * ID from the AdSense dashboard once the account exists and units are
 * created there — see apps/web/.env.example.
 */
const SLOT_ENV_VAR: Record<AdSlotName, string | undefined> = {
  home_below_mode_grid: import.meta.env.VITE_ADSENSE_SLOT_HOME as string | undefined,
  result_page_after_breakdown: import.meta.env.VITE_ADSENSE_SLOT_RESULT as string | undefined,
  leaderboard_below_table: import.meta.env.VITE_ADSENSE_SLOT_LEADERBOARD as string | undefined,
  site_anchor_footer: import.meta.env.VITE_ADSENSE_SLOT_ANCHOR as string | undefined,
};

/** CSS class carrying the slot's reserved min-height (see styles/adSlot.css). */
const SLOT_CLASS: Record<AdSlotName, string> = {
  home_below_mode_grid: "ad-slot-home",
  result_page_after_breakdown: "ad-slot-result",
  leaderboard_below_table: "ad-slot-leaderboard",
  site_anchor_footer: "ad-slot-anchor",
};

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

let scriptInjected = false;

/**
 * Inject the AdSense loader script. Idempotent — checks for an existing
 * tag before appending, and short-circuits after the first successful
 * call, mirroring utils/analytics.ts's `injectGtagScript`.
 *
 * TODO(ads-launch): this path is untested against a real AdSense account
 * (none exists yet). Smoke-test the injected script tag, the rendered
 * `<ins>` mount, and the `adsbygoogle.push({})` call end-to-end once real
 * publisher/ad-unit credentials are set.
 */
function loadAdSenseScript(clientId: string): void {
  if (scriptInjected) return;
  if (
    document.querySelector(
      'script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]',
    )
  ) {
    scriptInjected = true;
    return;
  }
  scriptInjected = true;
  const script = document.createElement("script");
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${clientId}`;
  document.head.appendChild(script);
}

export default function AdSlot({ slot }: AdSlotProps) {
  // Hooks are called unconditionally (rules of hooks) — the gate outcome
  // is computed into `shouldRender` and consumed both by the effect below
  // and by the early-return at the end of the component.
  const broadcast = useBroadcastMode();
  const { pathname } = useLocation();
  const { advertising } = useConsentPreferences();

  const adsEnabled = import.meta.env.VITE_ADS_ENABLED === "true";
  const clientId = import.meta.env.VITE_ADSENSE_CLIENT_ID as string | undefined;
  const slotId = SLOT_ENV_VAR[slot];
  const configured = adsEnabled && !!clientId && !!slotId;

  const isAdminRoute = pathname.startsWith("/admin");
  const shouldRender = configured && !broadcast && !isAdminRoute && advertising === true;

  useEffect(() => {
    if (!shouldRender || !clientId) return;
    loadAdSenseScript(clientId);
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // AdSense not ready yet, or blocked by an extension — non-fatal,
      // the <ins> mount just stays empty.
    }
    // Re-run if the resolved slot changes (e.g. navigating between pages
    // that each render a differently-configured AdSlot instance).
  }, [shouldRender, clientId, slot]);

  if (!shouldRender || !clientId || !slotId) return null;

  return (
    <div className={`ad-slot ${SLOT_CLASS[slot]}`} data-testid={`ad-slot-${slot}`}>
      <span className="ad-slot-label">Advertisement</span>
      <ins
        className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client={clientId}
        data-ad-slot={slotId}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
