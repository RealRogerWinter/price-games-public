import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { HelmetProvider } from "react-helmet-async";
import { useScreenHistory } from "./hooks/useScreenHistory";
import { useModalHistory } from "./hooks/useModalHistory";
import { BrowserRouter, Routes, Route, Navigate, useParams, useNavigate, useLocation, Link } from "react-router-dom";
import { CurrencyProvider } from "./context/CurrencyContext";
import { SoundProvider } from "./audio/SoundContext";
import { UserAuthProvider } from "./context/UserAuthContext";
import { EnabledPagesProvider } from "./context/EnabledPagesContext";
import { GamePauseProvider } from "./context/GamePauseContext";
import RequireEnabled from "./components/RequireEnabled";
import type { GameSession, GameMode, RoundCountOption } from "@price-game/shared";
import { DEFAULT_TOTAL_ROUNDS, VALID_GAME_MODES, MULTIPLAYER_ONLY_MODES } from "@price-game/shared";
import { startGame } from "./api/client";
import { useRejoinBanner } from "./hooks/useRejoinBanner";
import { useUserAuth } from "./context/UserAuthContext";
import ErrorBoundary from "./components/ErrorBoundary";
import SEO from "./components/SEO";
import SiteFooter from "./components/SiteFooter";
import CookieConsent from "./components/CookieConsent";
import NotificationPrompt from "./components/NotificationPrompt";
import IOSInstallPrompt from "./components/IOSInstallPrompt";
import NotificationToast from "./components/NotificationToast";
import RewardToastHost from "./components/multiplayer/RewardToastHost";
import BroadcastShell from "./broadcast/BroadcastShell";
import BroadcastNavHandle from "./broadcast/BroadcastNavHandle";
import { useBroadcastMode } from "./broadcast/useBroadcastMode";
import { AnalyticsProvider } from "./analytics";
import { getGameModeName } from "@price-game/shared";
import HomePage from "./pages/HomePage";
import DailyIntroPage from "./pages/DailyIntroPage";
const DailyResultPage = lazyWithRetry(() => import('./pages/DailyResultPage'));
import { useDaily, type DailyState } from "./hooks/useDaily";
import { markAnonCompleted } from "./utils/dailyStorage";
import type { DailyCompletionPayload } from "@price-game/shared";
import TopBar from "./components/TopBar";
import ChooseUsernameModal from "./components/auth/ChooseUsernameModal";
import AuthModal from "./components/auth/AuthModal";
import type { PromoBanner } from "@price-game/shared";
import GiveawayModal from "./components/GiveawayModal";
import treasureChestImg from "./assets/banner/giveaway-treasure-chest.webp";
import DailyRecapModal from "./components/home/DailyRecapModal";
import RewardTracker from "./components/RewardTracker";
import lazyWithRetry from "./utils/lazyWithRetry";

const GamePage = lazyWithRetry(() => import('./pages/GamePage'));
const HigherLowerPage = lazyWithRetry(() => import('./pages/HigherLowerPage'));
const ComparisonPage = lazyWithRetry(() => import('./pages/ComparisonPage'));
const ClosestPage = lazyWithRetry(() => import('./pages/ClosestPage'));
const PriceMatchPage = lazyWithRetry(() => import('./pages/PriceMatchPage'));
const RiserPage = lazyWithRetry(() => import('./pages/RiserPage'));
const OddOneOutPage = lazyWithRetry(() => import('./pages/OddOneOutPage'));
const MarketBasketPage = lazyWithRetry(() => import('./pages/MarketBasketPage'));
const SortItOutPage = lazyWithRetry(() => import('./pages/SortItOutPage'));
const BudgetBuilderPage = lazyWithRetry(() => import('./pages/BudgetBuilderPage'));
const ChainReactionPage = lazyWithRetry(() => import('./pages/ChainReactionPage'));
const ResultPage = lazyWithRetry(() => import('./pages/ResultPage'));
const LeaderboardPage = lazyWithRetry(() => import('./pages/LeaderboardPage'));
const MultiplayerPage = lazyWithRetry(() => import('./pages/MultiplayerPage'));
const AdminApp = lazyWithRetry(() => import('./pages/admin/AdminApp'));
const SettingsPage = lazyWithRetry(() => import('./pages/SettingsPage'));
const ScoreboardPage = lazyWithRetry(() => import('./pages/ScoreboardPage'));
const VerifyEmailPage = lazyWithRetry(() => import('./pages/VerifyEmailPage'));
const ForgotPasswordPage = lazyWithRetry(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazyWithRetry(() => import('./pages/ResetPasswordPage'));
const ClaimRewardPage = lazyWithRetry(() => import('./pages/ClaimRewardPage'));
const LegalPage = lazyWithRetry(() => import('./pages/LegalPage'));
const SharePage = lazyWithRetry(() => import('./pages/SharePage'));
const RecapPage = lazyWithRetry(() => import('./pages/RecapPage'));
const AboutPage = lazyWithRetry(() => import('./pages/AboutPage'));
const FAQPage = lazyWithRetry(() => import('./pages/FAQPage'));
const ContactPage = lazyWithRetry(() => import('./pages/ContactPage'));
const GameModesPage = lazyWithRetry(() => import('./pages/GameModesPage'));

/**
 * Scrolls the window to the top on every pathname change so that navigating
 * from the home page (which may be scrolled down) to any other route (e.g.
 * /mp or /scoreboard) lands the user at the top of the new page instead of
 * inheriting the previous scroll position. React Router v7 does not scroll
 * automatically for BrowserRouter + Routes setups.
 *
 * Skips the scroll when the navigation originated from a browser back /
 * forward button (popstate) so that history navigation preserves the user's
 * previous scroll position instead of snapping to the top.
 */
function ScrollToTop() {
  const { pathname } = useLocation();
  const isPopStateRef = useRef(false);

  useEffect(() => {
    function handlePopState() {
      isPopStateRef.current = true;
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (isPopStateRef.current) {
      isPopStateRef.current = false;
      return;
    }
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
      <BroadcastShell>
      <HelmetProvider>
      <SoundProvider>
        <CurrencyProvider>
          <UserAuthProvider>
            <EnabledPagesProvider>
            <GamePauseProvider>
            <BrowserRouter>
              <AnalyticsProvider>
              <ScrollToTop />
              <BroadcastNavHandle />
              <Suspense fallback={<div className="app"><div className="loading-screen"><p className="loading-text">Loading...</p></div></div>}>
                <Routes>
                  <Route path="/" element={<SinglePlayerApp />} />
                  <Route path="/admin/*" element={<AdminApp />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/scoreboard" element={<ScoreboardPage />} />
                  <Route path="/leaderboard" element={<LeaderboardRoute />} />
                  <Route path="/profile" element={<Navigate to="/settings" replace />} />
                  <Route path="/verify-email" element={<VerifyEmailPage />} />
                  <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                  <Route path="/reset-password" element={<ResetPasswordPage />} />
                  <Route path="/claim/:token" element={<ClaimRewardPage />} />
                  <Route path="/privacy" element={<RequireEnabled page="privacy"><LegalPage docKey="privacy_policy" title="Privacy Policy" /></RequireEnabled>} />
                  <Route path="/terms" element={<RequireEnabled page="terms"><LegalPage docKey="terms_of_service" title="Terms of Service" /></RequireEnabled>} />
                  <Route path="/about" element={<RequireEnabled page="about"><AboutPage /></RequireEnabled>} />
                  <Route path="/faq" element={<RequireEnabled page="faq"><FAQPage /></RequireEnabled>} />
                  <Route path="/contact" element={<RequireEnabled page="contact"><ContactPage /></RequireEnabled>} />
                  <Route path="/game-modes" element={<RequireEnabled page="game_modes"><GameModesPage /></RequireEnabled>} />
                  <Route path="/r/:code" element={<ReferralRedirect />} />
                  <Route path="/s/:id" element={<SharePage />} />
                  <Route path="/recap/:historyId" element={<RecapPage />} />
                  <Route path="/giveaway" element={<GiveawayRedirect />} />
                  <Route path="/player/:username" element={<PlayerProfileRoute />} />
                  <Route path="/mp" element={<MultiplayerRoute />} />
                  <Route path="/play/:mode" element={<SinglePlayerApp />} />
                  <Route path="/:roomCode" element={<MultiplayerRoute />} />
                </Routes>
              </Suspense>
              <CookieConsent />
              <NotificationPrompt />
              <IOSInstallPrompt />
              <NotificationToast />
              <RewardToastHost />
              </AnalyticsProvider>
            </BrowserRouter>
            </GamePauseProvider>
            </EnabledPagesProvider>
          </UserAuthProvider>
        </CurrencyProvider>
      </SoundProvider>
      </HelmetProvider>
      </BroadcastShell>
    </ErrorBoundary>
  );
}

function ReferralRedirect() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  useEffect(() => {
    if (code) {
      // Clamp to 20 chars to prevent storing excessively long values
      sessionStorage.setItem("referral_code", code.slice(0, 20));
    }
    navigate("/", { replace: true });
  }, [code, navigate]);
  return null;
}

/**
 * Deep-link to a player's profile. Renders the leaderboard with the
 * PlayerProfileModal pre-opened for the given username.
 */
function PlayerProfileRoute() {
  const { username } = useParams<{ username: string }>();
  const navigate = useNavigate();
  return (
    <div className="app">
      <main className="app-main">
        <LeaderboardPage onBack={() => navigate("/")} openUsername={username} />
      </main>
      <SiteFooter />
    </div>
  );
}

/**
 * Standalone /leaderboard route — a bookmarkable/shareable entry point for
 * the global lifetime leaderboard. The same page is also reachable from
 * `/?view=leaderboard` inside the single-player shell (which preserves an
 * active game session); this route is for direct navigation from links
 * that don't need to retain gameplay state (top-bar button, share URLs).
 */
function LeaderboardRoute() {
  const navigate = useNavigate();
  return (
    <div className="app">
      <main className="app-main">
        <LeaderboardPage onBack={() => navigate("/")} />
      </main>
      <SiteFooter />
    </div>
  );
}

/**
 * Ad landing page for `/giveaway`. Sets a session flag telling SinglePlayerApp
 * to auto-open the giveaway modal, then navigates to `/` so the user lands on
 * the home screen with the modal open. Shareable URL for Reddit ad traffic.
 */
function GiveawayRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    sessionStorage.setItem("open_giveaway", "1");
    navigate("/", { replace: true });
  }, [navigate]);
  return null;
}

function MultiplayerRoute() {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const { isAuthenticated } = useUserAuth();
  const searchParams = new URLSearchParams(window.location.search);
  const quickplayMode = searchParams.get("quickplay") as GameMode | null;
  // Daily-Bidding-War quickplay: the home flow sets ?daily=YYYY-MM-DD so this
  // route enters the daily matchmaking branch (same-date peers only, daily
  // puzzle products, once-per-day guard). Require quickplay=bidding so a
  // stray ?daily= param on an unrelated route doesn't silently enter the
  // daily path.
  const rawDaily = searchParams.get("daily") ?? undefined;
  const dailyDate = quickplayMode === "bidding" && rawDaily && /^\d{4}-\d{2}-\d{2}$/.test(rawDaily)
    ? rawDaily
    : undefined;
  // Local register-modal state — MultiplayerRoute is a sibling of
  // SinglePlayerApp, so we can't reuse SinglePlayerApp's modal; wire our own
  // so the MPResultsScreen CTA for logged-out players can open it.
  const [showAuthModal, setShowAuthModal] = useModalHistory("auth");
  return (
    <div className="app">
      <main className="app-main">
        <MultiplayerPage
          roomCode={roomCode}
          quickplayMode={quickplayMode || undefined}
          dailyDate={dailyDate}
          onLeave={() => { sessionStorage.removeItem("active_game"); navigate("/"); }}
          onOpenAuth={!isAuthenticated ? () => setShowAuthModal(true) : undefined}
        />
        {showAuthModal && !isAuthenticated && (
          <AuthModal onClose={() => setShowAuthModal(false)} initialMode="register" />
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

type Screen = "home" | "playing" | "result" | "leaderboard" | "daily-intro";

function SinglePlayerApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const broadcast = useBroadcastMode();
  // `/play/:mode` renders this component with a `mode` path param. When
  // present, it takes precedence over `?mode=` so the canonical per-mode
  // URL and the legacy query-param deep-link both funnel through the same
  // start-game effect below.
  const { mode: pathMode } = useParams<{ mode?: string }>();
  const { isAuthenticated, user, usernamePending, updateUser } = useUserAuth();
  const [screen, setScreen] = useScreenHistory<Screen>("home");
  const [session, setSession] = useState<GameSession | null>(null);
  const [roundResults, setRoundResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gameMode, setGameMode] = useState<GameMode>("classic");
  const [categories, setCategories] = useState<string[] | undefined>(undefined);
  const [selectedRounds, setSelectedRounds] = useState<RoundCountOption>(DEFAULT_TOTAL_ROUNDS);

  // Multiplayer confirmation state
  const [confirmMultiplayer, setConfirmMultiplayer] = useState<string | null>(null);

  // Daily challenge state
  const daily = useDaily();
  const [isPlayingDaily, setIsPlayingDaily] = useState(false);
  const [dailyCompletionPayload, setDailyCompletionPayload] = useState<DailyCompletionPayload | null>(null);

  // Restore game state on mount (e.g. after returning from /settings or
  // visiting the site during an unfinished session). We deliberately leave
  // the user on the home screen with the Resume Game button visible — the
  // old behavior that auto-navigated into the "playing" screen surprised
  // users who typed price.games expecting the landing page.
  useEffect(() => {
    const saved = sessionStorage.getItem("active_game");
    if (!saved) return;
    try {
      const data = JSON.parse(saved);
      if (data.session && !data.session.completed) {
        setSession(data.session);
        setRoundResults(data.roundResults ?? []);
        setGameMode(data.gameMode ?? "classic");
        setIsPlayingDaily(data.isPlayingDaily ?? false);
      }
    } catch {
      sessionStorage.removeItem("active_game");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to the top whenever the screen changes so users always land at
  // the top of a new view — otherwise the previous scroll position lingers
  // when moving from (e.g.) the mode grid into a game page.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [screen]);

  // Persist active game state so it survives navigation to /settings and back.
  // Skip when session is null (initial mount or no game started) to avoid
  // clearing the saved state before the restore effect can read it.
  useEffect(() => {
    if (!session) return;
    if (!session.completed) {
      sessionStorage.setItem("active_game", JSON.stringify({
        session, roundResults, gameMode, isPlayingDaily,
      }));
    } else {
      sessionStorage.removeItem("active_game");
    }
  }, [session, roundResults, gameMode, isPlayingDaily]);

  // Disabled game modes
  const [disabledModes, setDisabledModes] = useState<Set<string>>(new Set());

  // Promo banner — dismissal persists for 1 day via localStorage
  const [promoBanner, setPromoBanner] = useState<PromoBanner | null>(null);
  const [promoDismissed, setPromoDismissed] = useState(() => {
    const ts = localStorage.getItem("promo_banner_dismissed");
    if (!ts) return false;
    const elapsed = Date.now() - Number(ts);
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (elapsed < ONE_DAY) return true;
    localStorage.removeItem("promo_banner_dismissed");
    return false;
  });
  const [showGiveawayModal, setShowGiveawayModal] = useModalHistory("giveaway");
  // Recap modal for the completed daily challenge — opened from the home
  // card when the player taps "Recap" on the completed state.
  const [showDailyRecap, setShowDailyRecap] = useModalHistory("daily-recap");
  // Bumped after game end to re-fetch monthly points in RewardTracker
  const [trackerRefreshKey, setTrackerRefreshKey] = useState(0);
  // Auth modal state for opening registration from giveaway modal / banner
  const [showAuthModal, setShowAuthModal] = useModalHistory("auth");
  const [authModalMode, setAuthModalMode] = useState<"login" | "register">("register");

  // Close auth modal on successful authentication
  useEffect(() => {
    if (isAuthenticated) setShowAuthModal(false);
  }, [isAuthenticated]);

  // Re-fetch the daily challenge state whenever the authenticated user
  // changes. This handles two cases the initial mount effect misses:
  //   1. Anonymous → logged in: the anon fetch returned no `alreadyPlayed`
  //      flag, so the home card showed "Play" even for users who already
  //      completed today's daily on another device.
  //   2. Account switch: if another user signs in, we want their streak
  //      and completion state — not the previous user's cached values.
  //
  // Skip the refresh when `daily.state === "playing"` — refresh() flips
  // the state back to "loading" and then to "ready"/"already-played",
  // which would clobber an in-progress daily session (e.g., the user
  // registers mid-play via an auth modal). Also skip the redundant
  // initial-mount fetch: `useDaily` already fetched `/today` on mount,
  // so we only want to hit the endpoint again when the user ID
  // *changes* after that first fetch. A ref tracks the last user ID
  // we've refreshed for.
  const lastRefreshedUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!user) {
      lastRefreshedUserIdRef.current = null;
      return;
    }
    if (lastRefreshedUserIdRef.current === user.id) return;
    // Don't interrupt an in-progress daily — wait until the player
    // finishes or leaves before syncing state.
    if (daily.state === "playing") return;
    lastRefreshedUserIdRef.current = user.id;
    daily.refresh();
  }, [user, daily.state, daily.refresh]);

  // Auto-open the giveaway modal when the user arrived via the /giveaway
  // deep link (set by GiveawayRedirect). One-shot: the flag is cleared
  // immediately so a back-navigation to / does not reopen it.
  useEffect(() => {
    if (sessionStorage.getItem("open_giveaway") === "1") {
      sessionStorage.removeItem("open_giveaway");
      setShowGiveawayModal(true);
    }
  }, [setShowGiveawayModal]);

  useEffect(() => {
    fetch("/api/settings/banner")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data) setPromoBanner(data); })
      .catch(() => {});
    fetch("/api/settings/game-modes")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data?.disabledModes) setDisabledModes(new Set(data.disabledModes)); })
      .catch(() => {});
  }, []);

  // OAuth error banner (shown when redirected back with ?auth_error=...)
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("auth_error");
    if (err) {
      const messages: Record<string, string> = {
        cancelled: "Login was cancelled",
        invalid_state: "Login failed — please try again",
        oauth_failed: "Login failed — please try again",
      };
      setAuthError(messages[err] || "Login failed");
      // Clean the URL without a page reload
      window.history.replaceState({ ...window.history.state }, "", window.location.pathname);
    }
    // Deep-link: `/play/<mode>` (canonical) or `?mode=<mode>` (legacy) starts
    // that mode immediately. The canonical URL is linked from `/game-modes`
    // and indexed in sitemap.xml for per-mode SEO landing pages.
    const requestedMode = pathMode ?? params.get("mode");
    if (requestedMode && VALID_GAME_MODES.has(requestedMode) && !MULTIPLAYER_ONLY_MODES.has(requestedMode)) {
      const isBroadcast = params.get("broadcast") === "1";
      // For human users, normalize the URL to "/" so the in-app
      // home/play/result navigation is consistent regardless of how
      // they arrived (deep-link, mode picker, etc.).
      //
      // For the streaming bot (broadcast mode), keep the canonical
      // `/play/<mode>?broadcast=1` URL — the runner reload-recovers
      // from page_unhealthy by calling `page.reload()`, and a
      // normalized "/" reload would land on the home page with no
      // active game (the page's restore-from-storage path is
      // human-oriented and deliberately stays on home). Preserving
      // the URL means each reload re-fires this deep-link effect
      // and spawns a fresh game session.
      if (!isBroadcast) {
        window.history.replaceState({ ...window.history.state }, "", "/");
      }
      // Clear any stored "active_game" so the home-screen restore
      // path can't show a stale Resume banner over the broadcast UI
      // when doStartGame is awaiting the API call.
      sessionStorage.removeItem("active_game");
      doStartGame(requestedMode as GameMode, categories, selectedRounds, "game-browser");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Broadcast soft-nav: when the URL's `:mode` segment changes AFTER mount
  // (the streamer-bot driver flips it via `window.__pgBroadcastNav` at
  // plan boundaries instead of a full page.goto), start a fresh game in
  // the new mode without unmounting the BroadcastShell overlay. Skipped
  // on the initial mount — the mount effect above already covers the
  // first /play/<mode> deep-link. Skipped for human users because they
  // navigate via in-app screen state, not URL changes.
  const lastPathModeRef = useRef<string | undefined>(pathMode);
  useEffect(() => {
    if (lastPathModeRef.current === pathMode) return;
    const previousMode = lastPathModeRef.current;
    lastPathModeRef.current = pathMode;
    // First render: don't double-fire (mount effect handles initial path).
    if (previousMode === undefined) return;
    if (!broadcast) return;
    if (!pathMode) return;
    if (!VALID_GAME_MODES.has(pathMode) || MULTIPLAYER_ONLY_MODES.has(pathMode)) return;
    // Avoid restarting if the bot sent us back to the same mode mid-game
    // (e.g. a duplicate plan). Only restart when the mode genuinely
    // differs OR the previous game has completed.
    if (pathMode === gameMode && session && !session.completed) return;
    sessionStorage.removeItem("active_game");
    doStartGame(pathMode as GameMode, categories, selectedRounds, "game-browser");
  }, [pathMode, broadcast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep-link: ?view=leaderboard opens the leaderboard screen. Reactive
  // to location.search so it works even when already on "/" (the mount
  // effect above won't re-fire in that case).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("view") === "leaderboard") {
      setScreen("leaderboard");
      window.history.replaceState({ ...window.history.state }, "", location.pathname);
    }
  }, [location.search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to top whenever the internal screen changes — the /mp and
  // /scoreboard route changes are handled by the ScrollToTop component,
  // but screen transitions within SinglePlayerApp (e.g. home→leaderboard)
  // do not change the pathname, so we need a separate hook for them.
  //
  // useScreenHistory mutates `screen` in response to browser back/forward
  // via popstate; a scroll-to-top on that transition would clobber the
  // user's previous scroll position. Track popstate here so the effect
  // short-circuits on history-driven screen changes.
  const screenPopStateRef = useRef(false);
  useEffect(() => {
    function handlePopState() {
      screenPopStateRef.current = true;
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  useEffect(() => {
    if (screenPopStateRef.current) {
      screenPopStateRef.current = false;
      return;
    }
    window.scrollTo(0, 0);
  }, [screen]);

  // Multiplayer rejoin banner. Hoisted into `useRejoinBanner` so the
  // saved session is re-checked on every navigation (the previous
  // mount-only effect missed cases like "leave a game → land on home"
  // — the banner only appeared after a full refresh). The hook
  // debounces the underlying `/api/mp/room/{code}` lookup.
  const { rejoinInfo, clear: clearRejoinBanner } = useRejoinBanner();

  const doStartGame = useCallback(
    async (
      mode: GameMode,
      cats?: string[],
      rounds?: RoundCountOption,
      // Where this start originated. Defaults to "homepage" — covers the
      // mode-picker tap, the play-again button, and the post-error retry.
      // Pass "game-browser" when coming from /game-modes / /play/<mode>
      // deep-links so the analytics tile attributes the start to the
      // dedicated browse page rather than the landing screen.
      startSource: "homepage" | "game-browser" = "homepage",
    ) => {
      setLoading(true);
      setError(null);
      try {
        const s = await startGame(cats, mode, rounds ?? selectedRounds, startSource);
        setSession(s);
        setRoundResults([]);
        setGameMode(mode);
        setScreen("playing");
      } catch {
        setError("Failed to connect to server.");
      } finally {
        setLoading(false);
      }
    },
    [selectedRounds]
  );

  // Derive the hero card state from the useDaily hook
  const dailyCardState: import("./components/home/DailyHeroCard").DailyCardState = (() => {
    if (daily.state === "loading") return "loading";
    if (daily.state === "unavailable") return "unavailable";
    if (daily.state === "error") return "error";
    // "already-played" and "completed" both mean the player is done for the
    // day — render the hero card in its greyed-out completed state (with
    // countdown to the next daily) rather than hiding it entirely.
    if (daily.state === "already-played" || daily.state === "completed") return "completed";
    // "ready" or "playing" → determine first-ever vs available
    if (daily.streak && daily.streak.current === 0 && daily.streak.best === 0) return "first-ever";
    return "available";
  })();

  async function handleOpenDaily() {
    setScreen("daily-intro");
  }

  async function handleDailyStart() {
    // Daily Bidding War routes through MP matchmaking (same path as the
    // home-page Bidding War tile). MultiplayerPage reads the `daily=` query
    // param and calls /api/mp/quickplay with isDailyGame=true + dailyDate —
    // that both filters matchmaking to other daily players and, on
    // fallthrough, creates a bot room that pulls the daily puzzle's
    // preset products.
    if (daily.today?.gameMode === "bidding") {
      const date = daily.today.date;
      const target = `/mp?quickplay=bidding&daily=${encodeURIComponent(date)}`;
      // Any active session here implies the user already confirmed leaving
      // via the Home confirmDaily modal (the only path into daily-intro
      // when a game is in progress). Clear it and go — skip the redundant
      // multiplayer confirmation.
      if (session && !session.completed) {
        setSession(null);
        sessionStorage.removeItem("active_game");
      }
      navigate(target);
      return;
    }

    try {
      const dailySession = await daily.start();
      setSession(dailySession);
      setRoundResults([]);
      setGameMode(dailySession.gameMode);
      setIsPlayingDaily(true);
      setDailyCompletionPayload(null);
      setScreen("playing");
    } catch {
      // useDaily already transitions state on error
    }
  }

  function handleDailyGameEnd() {
    setScreen("result");
    setTrackerRefreshKey((k) => k + 1);
    // Mark the day as completed in localStorage so anonymous devices still
    // see the "already played" state on a same-day refresh. We deliberately
    // no longer mirror a streak count locally — see hooks/useDaily.ts for
    // the rationale (anonymous sessions show "Start a streak", not a
    // localStorage counter).
    if (daily.today) {
      markAnonCompleted(daily.today.date);
    }
  }

  function handleSelectMode(mode: GameMode) {
    setGameMode(mode);
    setIsPlayingDaily(false);
    doStartGame(mode, categories, selectedRounds);
  }

  function handleMultiplayer() {
    if (session && !session.completed) {
      setConfirmMultiplayer("/mp");
      return;
    }
    navigate("/mp");
  }

  function handleQuickPlayBidding() {
    if (session && !session.completed) {
      setConfirmMultiplayer("/mp?quickplay=bidding");
      return;
    }
    navigate("/mp?quickplay=bidding");
  }

  function handleRoundComplete(result: any, updatedSession: GameSession, dailyPayload?: DailyCompletionPayload) {
    setRoundResults((prev) => [...prev, result]);
    setSession(updatedSession);
    if (dailyPayload) {
      setDailyCompletionPayload(dailyPayload);
    }
  }

  function handleGameEnd() {
    setScreen("result");
    setTrackerRefreshKey((k) => k + 1);
  }

  function handlePlayAgain() {
    doStartGame(gameMode, categories, selectedRounds);
  }

  /**
   * Apply a category selection coming from GameOptionsMenu's inline panel.
   * On home we just save the selection (next game will pick it up). Mid-game
   * the v2 panel has already shown its own confirmation view, so we restart.
   */
  function handleApplyCategories(cats: string[]) {
    setCategories(cats);
    if (screen !== "home") {
      doStartGame(gameMode, cats);
    }
  }

  if (loading) {
    return (
      <div className="app">
        <main className="app-main">
          <div className="loading-screen">
            <h1 className="loading-title">price.games</h1>
            <p className="loading-text">{error || "Loading..."}</p>
            {error && (
              <button className="btn btn-primary" onClick={() => doStartGame(gameMode)}>
                Retry
              </button>
            )}
          </div>
        </main>
      </div>
    );
  }

  function handleRejoinGame() {
    if (rejoinInfo) {
      navigate(`/${rejoinInfo.roomCode}`);
    }
  }

  function handleDismissRejoin() {
    clearRejoinBanner();
  }

  const homeJsonLd = screen === "home"
    ? [
        {
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "Price Games",
          url: "https://price.games",
          potentialAction: {
            "@type": "SearchAction",
            target: "https://price.games/?q={search_term_string}",
            "query-input": "required name=search_term_string",
          },
        },
        {
          "@context": "https://schema.org",
          "@type": "VideoGame",
          name: "Price Games",
          url: "https://price.games",
          description:
            "Free multiplayer price-guessing game with multiple modes, daily challenge, and live multiplayer rooms.",
          genre: ["Trivia", "Casual", "Puzzle"],
          applicationCategory: "Game",
          gamePlatform: "Web browser",
          operatingSystem: "Web",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        },
      ]
    : undefined;

  // Built once per render and passed into <HomePage> via the `promoBannerSlot`
  // prop. The banner used to render at the very top of `.app`, but it pushed
  // the hero logo below the fold on mobile; HomePage now slots it between
  // the hero and the daily card.
  // Broadcast mode (24/7 stream bot) suppresses promotional UI to keep the
  // stream feed clean of dismissable banners and CTAs the bot can't interact
  // with. Returning null here also prevents the banner from being slotted
  // into HomePage and from intercepting layout calculations.
  const promoBannerNode = !broadcast && promoBanner?.enabled && !promoDismissed &&
    (promoBanner.audienceMode === "all" || isAuthenticated) ? (
    <div className="promo-banner" data-testid="promo-banner">
      <img
        className="promo-banner-icon"
        src={treasureChestImg}
        alt=""
        draggable={false}
      />
      <div className="promo-banner-body">
        <div className="promo-banner-top">
          <span className="promo-banner-text">{promoBanner.text}</span>
          {!isAuthenticated && (
            <button
              className="promo-banner-cta"
              onClick={() => { setAuthModalMode("register"); setShowAuthModal(true); }}
              data-testid="promo-banner-signup"
            >
              Sign Up
            </button>
          )}
          {isAuthenticated && !user?.emailVerified && (
            <button
              className="promo-banner-cta promo-banner-cta-warn"
              onClick={() => navigate("/settings")}
            >
              Verify Email
            </button>
          )}
          {promoBanner.showGiveawayModal && (
            <button
              className="promo-banner-cta promo-banner-cta-outline"
              onClick={() => setShowGiveawayModal(true)}
              data-testid="promo-banner-giveaway-btn"
            >
              Details
            </button>
          )}
          {promoBanner.showLink && promoBanner.linkText && promoBanner.linkUrl &&
            promoBanner.linkUrl.startsWith("/") && !promoBanner.linkUrl.startsWith("//") && (
            <button
              className="promo-banner-cta promo-banner-cta-outline"
              onClick={() => navigate(promoBanner.linkUrl)}
            >
              {promoBanner.linkText}
            </button>
          )}
        </div>
        {!isAuthenticated && (
          <span className="promo-banner-subtext">
            Register with a verified email to qualify.
          </span>
        )}
        {isAuthenticated && !user?.emailVerified && (
          <span className="promo-banner-subtext promo-banner-subtext-warning">
            Your email is not verified &mdash; verify to qualify for rewards.
          </span>
        )}
        {isAuthenticated && user?.emailVerified && !promoBanner.showTracker && (
          <span className="promo-banner-subtext promo-banner-subtext-ok">
            Registered and verified &mdash; you qualify for rewards!
          </span>
        )}
        {promoBanner.showTracker && promoBanner.giveawayMinPoints > 0 && (
          <RewardTracker
            banner={promoBanner}
            refreshKey={trackerRefreshKey}
          />
        )}
      </div>
      <button
        className="promo-banner-dismiss"
        onClick={() => { localStorage.setItem("promo_banner_dismissed", String(Date.now())); setPromoDismissed(true); }}
        title="Dismiss"
      >
        &times;
      </button>
    </div>
  ) : null;

  return (
    <div className="app">
      <SEO jsonLd={homeJsonLd} />
      <main className="app-main">
      {authError && (
        <div className="rejoin-banner" style={{ background: "#c0392b" }}>
          <span className="rejoin-banner-text">{authError}</span>
          <button className="rejoin-banner-dismiss" onClick={() => setAuthError(null)} title="Dismiss">
            &times;
          </button>
        </div>
      )}

      {rejoinInfo && (
        <div className="rejoin-banner">
          <span className="rejoin-banner-text">
            You have an active game in room <strong>{rejoinInfo.roomCode}</strong>
          </span>
          <button className="btn rejoin-banner-btn" onClick={handleRejoinGame}>
            Rejoin
          </button>
          <button className="rejoin-banner-dismiss" onClick={handleDismissRejoin} title="Dismiss">
            &times;
          </button>
        </div>
      )}

      {showGiveawayModal && (
        <GiveawayModal
          banner={promoBanner}
          onClose={() => setShowGiveawayModal(false)}
          onOpenRegister={() => { setAuthModalMode("register"); setShowAuthModal(true); }}
        />
      )}

      {showDailyRecap && daily.today && (
        <DailyRecapModal
          date={daily.today.date}
          playerName={user?.username ?? null}
          onClose={() => setShowDailyRecap(false)}
        />
      )}

      {screen === "daily-intro" && daily.today && (
        <DailyIntroPage
          today={daily.today}
          streak={daily.streak}
          onStart={handleDailyStart}
          onBack={() => setScreen("home")}
        />
      )}

      {screen === "home" && (
        <HomePage
          onSelectMode={handleSelectMode}
          onShowLeaderboard={() => setScreen("leaderboard")}
          onMultiplayer={handleMultiplayer}
          onQuickPlayBidding={handleQuickPlayBidding}
          onApplyCategories={handleApplyCategories}
          currentCategories={categories}
          selectedRounds={selectedRounds}
          onSelectRounds={setSelectedRounds}
          activeGameMode={session && !session.completed ? gameMode : undefined}
          activeGameRound={session && !session.completed ? session.currentRound : undefined}
          activeGameScore={session && !session.completed ? session.totalScore : undefined}
          onResumeGame={session && !session.completed ? () => setScreen("playing") : undefined}
          disabledModes={disabledModes}
          dailyToday={daily.today}
          dailyStreak={daily.streak}
          dailyState={dailyCardState}
          onOpenDaily={handleOpenDaily}
          onOpenDailyRecap={() => setShowDailyRecap(true)}
          promoBannerSlot={promoBannerNode}
        />
      )}

      {(screen === "playing" || screen === "leaderboard" || screen === "result") && (
        <TopBar
          onGoHome={() => setScreen("home")}
          onApplyCategories={handleApplyCategories}
          currentCategories={categories}
          requireRestartConfirm={
            screen === "playing" &&
            !!session &&
            !session.completed &&
            session.currentRound > 1
          }
          selectedRounds={selectedRounds}
          onSelectRounds={setSelectedRounds}
          showIdentityCard={screen === "playing"}
          onOpenRegister={() => { setAuthModalMode("register"); setShowAuthModal(true); }}
        />
      )}

      {screen === "playing" && session && (
        <>

          {gameMode === "classic" && (
            <GamePage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={isPlayingDaily ? handleDailyGameEnd : handleGameEnd}
            />
          )}
          {gameMode === "higher-lower" && (
            <HigherLowerPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={isPlayingDaily ? handleDailyGameEnd : handleGameEnd}
            />
          )}
          {gameMode === "comparison" && (
            <ComparisonPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={isPlayingDaily ? handleDailyGameEnd : handleGameEnd}
            />
          )}
          {gameMode === "closest-without-going-over" && (
            <ClosestPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={handleGameEnd}
            />
          )}
          {gameMode === "bidding" && (
            // Single-player Bidding War (daily challenge). Reuses ClosestPage:
            // same UX (one product, one price input, closest-under wins) but
            // the server scores it using closest-without-going-over bidding rules.
            <ClosestPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={isPlayingDaily ? handleDailyGameEnd : handleGameEnd}
            />
          )}
          {gameMode === "price-match" && (
            <PriceMatchPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={handleGameEnd}
            />
          )}
          {gameMode === "riser" && (
            <RiserPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={handleGameEnd}
            />
          )}
          {gameMode === "odd-one-out" && (
            <OddOneOutPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={handleGameEnd}
            />
          )}
          {gameMode === "market-basket" && (
            <MarketBasketPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={handleGameEnd}
            />
          )}
          {gameMode === "sort-it-out" && (
            <SortItOutPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={handleGameEnd}
            />
          )}
          {gameMode === "budget-builder" && (
            <BudgetBuilderPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={handleGameEnd}
            />
          )}
          {gameMode === "chain-reaction" && (
            <ChainReactionPage
              key={session.id}
              session={session}
              onRoundComplete={handleRoundComplete}
              onGameEnd={handleGameEnd}
            />
          )}
        </>
      )}

      {screen === "result" && session && isPlayingDaily && daily.today && (
        <DailyResultPage
          session={session}
          roundResults={roundResults}
          today={daily.today}
          dailyPayload={dailyCompletionPayload}
          onBackToModes={() => { setIsPlayingDaily(false); setScreen("home"); daily.refresh(); }}
          onOpenRegister={!isAuthenticated ? () => { setAuthModalMode("register"); setShowAuthModal(true); } : undefined}
        />
      )}

      {screen === "result" && session && !isPlayingDaily && (
        <ResultPage
          session={session}
          roundResults={roundResults}
          gameMode={gameMode}
          onPlayAgain={handlePlayAgain}
          onShowLeaderboard={() => setScreen("leaderboard")}
          onBackToModes={() => setScreen("home")}
          onOpenAuth={() => { setAuthModalMode("register"); setShowAuthModal(true); }}
        />
      )}

      {screen === "leaderboard" && (
        <LeaderboardPage
          onBack={() =>
            setScreen(
              session?.completed ? "result" : session ? "playing" : "home"
            )
          }
          hasActiveGame={!!session && !session.completed}
        />
      )}

      {showAuthModal && !isAuthenticated && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          initialMode={authModalMode}
        />
      )}

      {usernamePending && (
        <ChooseUsernameModal onComplete={updateUser} />
      )}

      {confirmMultiplayer && session && !session.completed && (
        <div className="modal-overlay" onClick={() => setConfirmMultiplayer(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-modal-title">Game in Progress</h3>
            <p className="confirm-modal-text">
              You have an active <strong>{getGameModeName(gameMode)}</strong> game
              {session.currentRound != null ? ` (Round ${session.currentRound}` : ""}
              {session.totalScore !== undefined ? `, ${session.totalScore.toLocaleString()} pts` : ""}
              {session.currentRound != null ? ")" : ""}.
            </p>
            <p className="confirm-modal-warning">
              Starting a multiplayer game will lose your current progress.
            </p>
            <div className="confirm-modal-actions">
              <button
                className="confirm-btn-resume"
                onClick={() => { setConfirmMultiplayer(null); setScreen("playing"); }}
              >
                Resume Game
              </button>
              <button
                className="confirm-btn-new"
                onClick={() => { const dest = confirmMultiplayer; setConfirmMultiplayer(null); setSession(null); sessionStorage.removeItem("active_game"); navigate(dest); }}
              >
                Go to Multiplayer
              </button>
            </div>
          </div>
        </div>
      )}
      </main>

      <SiteFooter />
    </div>
  );
}
