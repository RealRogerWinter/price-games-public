import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import { renderWithProviders, makeSession, flushMicrotasks } from "./testUtils";

// Mock lazy-loaded pages as simple stubs
vi.mock("../pages/GamePage", () => ({
  default: ({ session }: any) => <div data-testid="game-page">GamePage {session.id}</div>,
}));
vi.mock("../pages/HigherLowerPage", () => ({
  default: ({ session }: any) => <div data-testid="higher-lower-page">HigherLowerPage {session.id}</div>,
}));
vi.mock("../pages/ComparisonPage", () => ({
  default: () => <div data-testid="comparison-page">ComparisonPage</div>,
}));
vi.mock("../pages/ClosestPage", () => ({
  default: () => <div data-testid="closest-page">ClosestPage</div>,
}));
vi.mock("../pages/PriceMatchPage", () => ({
  default: () => <div data-testid="price-match-page">PriceMatchPage</div>,
}));
vi.mock("../pages/RiserPage", () => ({
  default: () => <div data-testid="riser-page">RiserPage</div>,
}));
vi.mock("../pages/ResultPage", () => ({
  default: ({ onPlayAgain, onBackToModes }: any) => (
    <div data-testid="result-page">
      ResultPage
      <button onClick={onPlayAgain}>Play Again</button>
      <button onClick={onBackToModes}>Back to Modes</button>
    </div>
  ),
}));
vi.mock("../pages/LeaderboardPage", () => ({
  default: ({ onBack }: any) => (
    <div data-testid="leaderboard-page">
      LeaderboardPage
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../pages/MultiplayerPage", () => ({
  default: () => <div data-testid="multiplayer-page">MultiplayerPage</div>,
}));
vi.mock("../pages/SettingsPage", () => ({
  default: () => <div data-testid="settings-page">SettingsPage</div>,
}));
vi.mock("../pages/ScoreboardPage", () => ({
  default: () => <div data-testid="scoreboard-page">ScoreboardPage</div>,
}));

// Mock notification components — they rely on browser APIs (serviceWorker, PushManager)
// unavailable in jsdom
vi.mock("../components/NotificationPrompt", () => ({ default: () => null }));
vi.mock("../components/IOSInstallPrompt", () => ({ default: () => null }));
vi.mock("../components/NotificationToast", () => ({ default: () => null }));

// Mock socket module to prevent real connections
vi.mock("../api/socket", () => ({
  connectSocket: vi.fn(() => ({
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    io: { on: vi.fn(), off: vi.fn() },
  })),
  getSocket: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    connected: false,
  })),
  disconnectSocket: vi.fn(),
  savePlayerSession: vi.fn(),
  getPlayerSession: vi.fn(() => null),
  clearPlayerSession: vi.fn(),
}));

// Mock user client to prevent real API calls
vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn().mockRejectedValue(new Error("401")),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import * as api from "../api/client";
import * as socket from "../api/socket";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);
const mockedSocket = vi.mocked(socket);

// We need to import SinglePlayerApp indirectly — render the full App won't work
// because it uses BrowserRouter. Instead, import and render components that
// SinglePlayerApp renders.
// Actually, we can import App and it will render within jsdom's window.location
import App from "../App";

/** Click a mode card by its label text. Single-player mode cards are `<Link>`
 *  anchors to `/play/<mode>`; the multiplayer, bidding and Random cards are
 *  still buttons, so match either. Shared by both describe blocks. */
function clickModeCard(label: string) {
  fireEvent.click(screen.getByText(label).closest("a, button")!);
}

describe("App", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // Reset URL to root so BrowserRouter starts fresh each test
    window.history.pushState({}, "", "/");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedSocket.getPlayerSession.mockReturnValue(null);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("renders homepage by default", async () => {
    renderWithProviders(<App />);
    await flushMicrotasks();

    expect(screen.getByAltText("price.games")).toBeInTheDocument();
  });

  /** Click a game mode card by its label text. Single-player mode cards are
   *  `<Link>` anchors to `/play/<mode>`; the multiplayer and Random cards are
   *  still buttons, so match either. */
  function clickModeButton(label: string) {
    const heading = screen.getByText(label);
    const card = heading.closest("a, button");
    fireEvent.click(card!);
  }

  it("shows loading state when starting a game", async () => {
    // Make startGame hang
    mockedApi.startGame.mockReturnValue(new Promise(() => {}));

    renderWithProviders(<App />);
    await flushMicrotasks();

    clickModeButton("Precision");
    await flushMicrotasks();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("returns to home screen when startGame fails", async () => {
    mockedApi.startGame.mockRejectedValue(new Error("Network error"));

    renderWithProviders(<App />);
    await flushMicrotasks();

    await act(async () => {
      clickModeCard("Precision");
    });
    await flushMicrotasks();

    // After failure, loading=false so the home page shows again
    expect(screen.getByAltText("price.games")).toBeInTheDocument();
  });

  it("navigates to game screen after starting classic game", async () => {
    const session = makeSession({ id: "test-session" });
    mockedApi.startGame.mockResolvedValue(session);

    renderWithProviders(<App />);
    await flushMicrotasks();

    await act(async () => {
      clickModeCard("Precision");
    });

    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });
    expect(screen.getByText("GamePage test-session")).toBeInTheDocument();
  });

  it("navigates to higher-lower page for that mode", async () => {
    const session = makeSession({ id: "hl-session", gameMode: "higher-lower" });
    mockedApi.startGame.mockResolvedValue(session);

    renderWithProviders(<App />);
    await flushMicrotasks();

    await act(async () => {
      clickModeCard("Higher or Lower");
    });

    await waitFor(() => {
      expect(screen.getByTestId("higher-lower-page")).toBeInTheDocument();
    });
  });

  it("shows top bar with New Game and Options buttons during gameplay", async () => {
    const session = makeSession();
    mockedApi.startGame.mockResolvedValue(session);

    renderWithProviders(<App />);
    await flushMicrotasks();

    await act(async () => {
      clickModeCard("Precision");
    });

    await waitFor(() => {
      expect(screen.getByText("New Game")).toBeInTheDocument();
    });
    expect(screen.getByText("Options")).toBeInTheDocument();
  });

  it("navigates to leaderboard from home", async () => {
    renderWithProviders(<App />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leaderboard" }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("leaderboard-page")).toBeInTheDocument();
    });
  });

  it("goes back to home from leaderboard when no session", async () => {
    renderWithProviders(<App />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leaderboard" }));
    });

    await waitFor(() => {
      expect(screen.getByText("Back")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Back"));
    });

    await waitFor(() => {
      expect(screen.getByAltText("price.games")).toBeInTheDocument();
    });
  });

  it("shows affiliate disclosure footer", async () => {
    renderWithProviders(<App />);
    await flushMicrotasks();

    expect(screen.getByText(/Amazon Associate/)).toBeInTheDocument();
  });

  it("shows rejoin banner when saved multiplayer session exists", async () => {
    mockedSocket.getPlayerSession.mockReturnValue({
      roomCode: "ABCD",
      playerId: "p1",
      playerToken: "token1",
    });
    // Mock the room validation fetch
    fetchSpy.mockImplementation((input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/mp/room/ABCD")) {
        return Promise.resolve(new Response(JSON.stringify({ status: "lobby" })));
      }
      return Promise.resolve(new Response(JSON.stringify({ rates: {} })));
    });

    renderWithProviders(<App />);

    // useRejoinBanner debounces ~250ms before fetching, then awaits the
    // response — `waitFor` polls past both stages.
    await waitFor(() => {
      expect(screen.getByText(/active game in room/)).toBeInTheDocument();
    });
    expect(screen.getByText("ABCD")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rejoin" })).toBeInTheDocument();
  });

  it("dismisses rejoin banner and clears session", async () => {
    mockedSocket.getPlayerSession.mockReturnValue({
      roomCode: "ABCD",
      playerId: "p1",
      playerToken: "token1",
    });
    fetchSpy.mockImplementation((input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/mp/room/ABCD")) {
        return Promise.resolve(new Response(JSON.stringify({ status: "lobby" })));
      }
      return Promise.resolve(new Response(JSON.stringify({ rates: {} })));
    });

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByText(/active game in room/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("Dismiss"));
    });
    await flushMicrotasks();

    expect(screen.queryByText(/active game in room/)).not.toBeInTheDocument();
    expect(mockedSocket.clearPlayerSession).toHaveBeenCalled();
  });

  it("does not show rejoin banner when room is finished", async () => {
    mockedSocket.getPlayerSession.mockReturnValue({
      roomCode: "ABCD",
      playerId: "p1",
      playerToken: "token1",
    });
    fetchSpy.mockImplementation((input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/mp/room/ABCD")) {
        return Promise.resolve(new Response(JSON.stringify({ status: "finished" })));
      }
      return Promise.resolve(new Response(JSON.stringify({ rates: {} })));
    });

    renderWithProviders(<App />);
    await flushMicrotasks();
    // Wait long enough for the debounce + fetch to settle. The negative
    // assertion is intentional — the banner should never appear.
    await new Promise((r) => setTimeout(r, 350));
    await flushMicrotasks();

    expect(screen.queryByText(/active game in room/)).not.toBeInTheDocument();
  });

  it("clears stale session when room no longer exists", async () => {
    mockedSocket.getPlayerSession.mockReturnValue({
      roomCode: "GONE",
      playerId: "p1",
      playerToken: "token1",
    });
    fetchSpy.mockImplementation((input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/mp/room/GONE")) {
        return Promise.resolve(new Response("", { status: 404 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ rates: {} })));
    });

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(mockedSocket.clearPlayerSession).toHaveBeenCalled();
    });

    expect(screen.queryByText(/active game in room/)).not.toBeInTheDocument();
  });

  it("navigates to /mp when Multiplayer is clicked", async () => {
    renderWithProviders(<App />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("multiplayer-page")).toBeInTheDocument();
    });
  });

  it("expands inline categories panel inside Game Options from the home screen", async () => {
    // Mock getCategories for the inline v2 category panel.
    mockedApi.getCategories.mockResolvedValue({
      categories: [
        { name: "Electronics", count: 20 },
        { name: "Home & Kitchen", count: 18 },
      ],
    });

    renderWithProviders(<App />);
    await flushMicrotasks();

    // Open Game Options dropdown, then click Categories — the panel
    // should expand inline (no modal overlay).
    fireEvent.click(screen.getByText("Game Options"));
    fireEvent.click(screen.getByText("Categories"));

    await waitFor(() => {
      expect(screen.getByText("Electronics")).toBeInTheDocument();
    });
    // No modal overlay in the DOM — the panel lives inside the dropdown.
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("shows New Game button that returns to home during gameplay", async () => {
    const session = makeSession();
    mockedApi.startGame.mockResolvedValue(session);

    renderWithProviders(<App />);
    await flushMicrotasks();

    await act(async () => {
      clickModeCard("Precision");
    });

    await waitFor(() => {
      expect(screen.getByText("New Game")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("New Game"));
    await flushMicrotasks();

    // Should be back on home page
    expect(screen.getByAltText("price.games")).toBeInTheDocument();
  });

  // Leaderboard is now in the user dropdown, not the top bar

  it("/settings route renders SettingsPage", async () => {
    window.history.pushState({}, "", "/settings");
    renderWithProviders(<App />);
    await flushMicrotasks();

    await waitFor(() => {
      expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    });
  });

  it("/scoreboard route renders ScoreboardPage", async () => {
    window.history.pushState({}, "", "/scoreboard");
    renderWithProviders(<App />);
    await flushMicrotasks();

    await waitFor(() => {
      expect(screen.getByTestId("scoreboard-page")).toBeInTheDocument();
    });
  });

  it("/profile redirects to /settings", async () => {
    window.history.pushState({}, "", "/profile");
    renderWithProviders(<App />);
    await flushMicrotasks();

    await waitFor(() => {
      expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe("/settings");
  });

  it("wraps in UserAuthProvider", async () => {
    // Verify app renders without crashing (UserAuthProvider is present)
    // The UserDropdown renders auth buttons that require UserAuthProvider
    renderWithProviders(<App />);
    await flushMicrotasks();

    // The app should render normally with UserAuthProvider wrapping it
    expect(screen.getByAltText("price.games")).toBeInTheDocument();
  });

  describe("browser back button navigation", () => {
    let pushStateSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      pushStateSpy = vi.spyOn(window.history, "pushState");
    });

    afterEach(() => {
      pushStateSpy?.mockRestore();
    });

    it("pushes history state when navigating to playing screen", async () => {
      const session = makeSession({ id: "back-test" });
      mockedApi.startGame.mockResolvedValue(session);

      renderWithProviders(<App />);
      await flushMicrotasks();

      await act(async () => {
        clickModeCard("Precision");
      });

      await waitFor(() => {
        expect(screen.getByTestId("game-page")).toBeInTheDocument();
      });

      expect(pushStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ screen: "playing" }),
        ""
      );
    });

    it("pushes history state when navigating to leaderboard", async () => {
      renderWithProviders(<App />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Leaderboard" }));
      });

      await waitFor(() => {
        expect(screen.getByTestId("leaderboard-page")).toBeInTheDocument();
      });

      expect(pushStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ screen: "leaderboard" }),
        ""
      );
    });

    it("browser back from playing returns to home", async () => {
      const session = makeSession({ id: "back-nav" });
      mockedApi.startGame.mockResolvedValue(session);

      renderWithProviders(<App />);
      await flushMicrotasks();

      await act(async () => {
        clickModeCard("Precision");
      });

      await waitFor(() => {
        expect(screen.getByTestId("game-page")).toBeInTheDocument();
      });

      // Simulate browser back button
      await act(async () => {
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: { screen: "home" } })
        );
      });

      await waitFor(() => {
        expect(screen.getByAltText("price.games")).toBeInTheDocument();
      });
    });

    it("browser back from leaderboard returns to home", async () => {
      renderWithProviders(<App />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Leaderboard" }));
      });

      await waitFor(() => {
        expect(screen.getByTestId("leaderboard-page")).toBeInTheDocument();
      });

      // Simulate browser back button
      await act(async () => {
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: { screen: "home" } })
        );
      });

      await waitFor(() => {
        expect(screen.getByAltText("price.games")).toBeInTheDocument();
      });
    });
  });

  describe("browser back button closes modals", () => {
    it("back button navigates from multiplayer page to home", async () => {
      renderWithProviders(<App />);
      await flushMicrotasks();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /play with friends/i }));
      });

      await waitFor(() => {
        expect(screen.getByTestId("multiplayer-page")).toBeInTheDocument();
      });

      // Simulate browser back (React Router listens on popstate)
      await act(async () => {
        window.history.back();
      });

      await waitFor(() => {
        expect(screen.queryByTestId("multiplayer-page")).not.toBeInTheDocument();
      });
      expect(screen.getByAltText("price.games")).toBeInTheDocument();
    });
  });

  describe("/giveaway route", () => {
    it("auto-opens the giveaway modal and rewrites the URL to /", async () => {
      window.history.pushState({}, "", "/giveaway");

      renderWithProviders(<App />);
      await flushMicrotasks();

      await waitFor(() => {
        expect(screen.getByTestId("giveaway-modal")).toBeInTheDocument();
      });
      // The GiveawayRedirect component should have replaced the URL back to /
      expect(window.location.pathname).toBe("/");
    });

    it("does not open the giveaway modal on the home route by default", async () => {
      window.history.pushState({}, "", "/");

      renderWithProviders(<App />);
      await flushMicrotasks();

      expect(screen.queryByTestId("giveaway-modal")).not.toBeInTheDocument();
    });
  });

  describe("broadcast soft-nav between modes", () => {
    // The streamer-bot driver flips the URL via `window.__pgBroadcastNav`
    // at plan boundaries instead of a full `page.goto`. App.tsx watches
    // `pathMode` and starts a fresh game in the new mode without
    // unmounting the BroadcastShell overlay. These tests pin that
    // behaviour so a refactor can't silently revert us to a hard reload
    // per game.

    it("starts a fresh game when pathMode changes under broadcast=1", async () => {
      mockedApi.startGame.mockClear();
      const first = makeSession({ id: "first-session", gameMode: "classic" });
      const second = makeSession({ id: "second-session", gameMode: "higher-lower" });
      mockedApi.startGame.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      window.history.pushState({}, "", "/play/classic?broadcast=1");

      renderWithProviders(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("game-page")).toBeInTheDocument();
      });
      expect(mockedApi.startGame).toHaveBeenCalledTimes(1);
      expect(mockedApi.startGame.mock.calls[0]![1]).toBe("classic");

      // Simulate the bot calling `window.__pgBroadcastNav(...)` — the
      // helper itself lives in BroadcastNavHandle, but for this test
      // we approximate it with a direct history push + a popstate-like
      // re-render via React Router's internal state. Easiest reliable
      // path: dispatch a pushState through window.history and trigger
      // a popstate event so the router's listener picks it up.
      await act(async () => {
        window.history.pushState({}, "", "/play/higher-lower?broadcast=1");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      await waitFor(() => {
        expect(mockedApi.startGame).toHaveBeenCalledTimes(2);
      });
      expect(mockedApi.startGame.mock.calls[1]![1]).toBe("higher-lower");
    });

    it("does not restart the game on a duplicate same-mode soft-nav", async () => {
      // The bot occasionally re-issues a plan with the same mode after
      // a rotation flake. Restarting would clobber an in-progress
      // session and cause the round path to re-fire from round 1; the
      // guard at App.tsx skips the call when (pathMode === gameMode)
      // and an active session is in flight.
      mockedApi.startGame.mockClear();
      const session = makeSession({ id: "first-session", gameMode: "classic" });
      mockedApi.startGame.mockResolvedValue(session);
      window.history.pushState({}, "", "/play/classic?broadcast=1");

      renderWithProviders(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("game-page")).toBeInTheDocument();
      });
      const beforeCount = mockedApi.startGame.mock.calls.length;

      await act(async () => {
        window.history.pushState({}, "", "/play/classic?broadcast=1");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await flushMicrotasks();

      // Same mode + active session → no new startGame call.
      expect(mockedApi.startGame.mock.calls.length).toBe(beforeCount);
    });
  });
});

describe("/play/<mode> canonical URL", () => {
  // `/play/<mode>` is each mode's indexable, canonical URL. It used to
  // rewrite itself to "/" on mount, so the page a searcher landed on
  // stopped existing the moment React booted and all eleven mode URLs
  // collapsed onto the home page. These tests pin the URL to the route.

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.pushState({}, "", "/");
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedSocket.getPlayerSession.mockReturnValue(null);
    mockedApi.startGame.mockClear();
    // react-helmet-async appends into the shared jsdom document.head and does
    // not clean up on unmount, so JSON-LD from an earlier test would
    // otherwise still be in the DOM when the next one queries it.
    document
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => el.remove());
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("keeps the mode URL in the address bar while playing", async () => {
    mockedApi.startGame.mockResolvedValue(makeSession({ id: "s1", gameMode: "classic" }));
    window.history.pushState({}, "", "/play/classic");

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });

    expect(mockedApi.startGame.mock.calls[0]![1]).toBe("classic");
    expect(window.location.pathname).toBe("/play/classic");
  });

  it("still normalizes the legacy ?mode= deep link to /", async () => {
    // "/" is that entry point's own canonical — only the path form is
    // an indexable page.
    mockedApi.startGame.mockResolvedValue(makeSession({ id: "s2", gameMode: "classic" }));
    window.history.pushState({}, "", "/?mode=classic");

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });

    expect(window.location.pathname).toBe("/");
  });

  it("drops back to / when the player leaves the mode for the home screen", async () => {
    // The home screen is not the mode's page, so it must not render
    // under the mode's canonical URL.
    mockedApi.startGame.mockResolvedValue(makeSession({ id: "s3", gameMode: "classic" }));
    window.history.pushState({}, "", "/play/classic");

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe("/play/classic");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Home"));
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("keeps the mode URL on the result screen", async () => {
    // `playing` and `result` are both that mode's page — only screens that
    // are a different page drop back to "/".
    const session = makeSession({ id: "s4", gameMode: "classic" });
    mockedApi.startGame.mockResolvedValue(session);
    window.history.pushState({}, "", "/play/classic");

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });

    await act(async () => {
      window.history.pushState({ ...window.history.state, screen: "result" }, "");
      window.dispatchEvent(new PopStateEvent("popstate", { state: { ...window.history.state, screen: "result" } }));
    });

    expect(window.location.pathname).toBe("/play/classic");
  });

  it("leaves the mode URL when the deep-link start fails", async () => {
    // The error path used to strand the player on /play/<mode> rendering
    // the home screen — the exact canonical/content mismatch this fixes.
    mockedApi.startGame.mockRejectedValue(new Error("boom"));
    window.history.pushState({}, "", "/play/classic");

    renderWithProviders(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("preserves the useScreenHistory screen key when leaving a mode route", async () => {
    // react-router's replace() writes a fresh {usr,key,idx} state object.
    // Without re-stamping `screen`, useScreenHistory's popstate handler
    // ignores the entry and the browser forward button silently dies.
    mockedApi.startGame.mockResolvedValue(makeSession({ id: "s5", gameMode: "classic" }));
    window.history.pushState({}, "", "/play/classic");

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Home"));
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(window.history.state?.screen).toBe("home");
  });

  it("starts the game at the canonical URL when a home mode card is clicked", async () => {
    // `/` and `/play/:mode` share a route element, so React reconciles
    // instead of remounting and the mount effect never re-fires — the
    // soft-nav effect is what turns the URL change into a game.
    mockedApi.startGame.mockResolvedValue(makeSession({ id: "s7", gameMode: "classic" }));
    renderWithProviders(<App />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByText("Precision"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe("/play/classic");
    expect(mockedApi.startGame.mock.calls[0]![1]).toBe("classic");
  });

  it("starts a different mode when navigating between two mode URLs", async () => {
    const first = makeSession({ id: "a", gameMode: "classic" });
    const second = makeSession({ id: "b", gameMode: "higher-lower" });
    mockedApi.startGame.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    window.history.pushState({}, "", "/play/classic");

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });

    await act(async () => {
      window.history.pushState({}, "", "/play/higher-lower");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(mockedApi.startGame).toHaveBeenCalledTimes(2);
    });
    expect(mockedApi.startGame.mock.calls[1]![1]).toBe("higher-lower");
    expect(window.location.pathname).toBe("/play/higher-lower");
  });

  it("does not restart an in-progress game when the mode URL is re-entered", async () => {
    // `/play/<mode>` is a plain GET, so the browser's forward button lands
    // here with no click to intercept. Without a guard, / -> card -> play ->
    // Back -> Forward silently discards the session and its score.
    const session = makeSession({ id: "keep-me", gameMode: "classic" });
    mockedApi.startGame.mockResolvedValue(session);
    window.history.pushState({}, "", "/play/classic");

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });
    expect(mockedApi.startGame).toHaveBeenCalledTimes(1);
    sessionStorage.setItem("active_game", JSON.stringify({ session }));

    // Leave the mode URL, then come back to it the way Forward would.
    await act(async () => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      window.history.pushState({}, "", "/play/classic");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flushMicrotasks();

    // Same mode, live session → no second start, and the stored game is
    // still there (the removeItem must sit after the guard, not before).
    expect(mockedApi.startGame).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("active_game")).not.toBeNull();
  });

  it("starts a new game after confirming over one already in progress", async () => {
    // PRODUCTION REGRESSION. With a game in progress the home card click is
    // intercepted by the "Game in Progress" prompt, and confirming routes
    // through handleSelectMode instead of the link. The restart guard read
    // the optimistic `gameMode` state rather than the running session's
    // mode, so the explicit restart looked like a duplicate navigation and
    // was silently dropped: the URL changed and no game ever started.
    const first = makeSession({ id: "old", gameMode: "classic" });
    const next = makeSession({ id: "new", gameMode: "higher-lower" });
    mockedApi.startGame.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    window.history.pushState({}, "", "/play/classic");

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("game-page")).toBeInTheDocument();
    });
    expect(mockedApi.startGame).toHaveBeenCalledTimes(1);

    // Back to home with the game still live, then pick a different mode.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Home"));
    });
    await waitFor(() => expect(window.location.pathname).toBe("/"));

    await act(async () => {
      clickModeCard("Higher or Lower");
    });
    expect(screen.getByText("Game in Progress")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText("Start New Game"));
    });

    await waitFor(() => {
      expect(mockedApi.startGame).toHaveBeenCalledTimes(2);
    });
    expect(mockedApi.startGame.mock.calls[1]![1]).toBe("higher-lower");
    await waitFor(() => {
      expect(screen.getByTestId("higher-lower-page")).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe("/play/higher-lower");
  });

  it("restarts the same mode when that is what was confirmed", async () => {
    // The same-mode case is the one a `session.gameMode === pathMode` guard
    // would still swallow without clearing the session on explicit intent.
    const first = makeSession({ id: "old", gameMode: "classic" });
    const again = makeSession({ id: "again", gameMode: "classic" });
    mockedApi.startGame.mockResolvedValueOnce(first).mockResolvedValueOnce(again);
    window.history.pushState({}, "", "/play/classic");

    renderWithProviders(<App />);
    await waitFor(() => expect(screen.getByTestId("game-page")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Home"));
    });
    await waitFor(() => expect(window.location.pathname).toBe("/"));

    await act(async () => {
      clickModeCard("Precision");
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Start New Game"));
    });

    await waitFor(() => {
      expect(mockedApi.startGame).toHaveBeenCalledTimes(2);
    });
    expect(window.location.pathname).toBe("/play/classic");
  });

  it("redirects the multiplayer-only mode to the lobby", async () => {
    window.history.pushState({}, "", "/play/bidding");

    renderWithProviders(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/mp");
    });
    expect(mockedApi.startGame).not.toHaveBeenCalled();
  });

  it("redirects an unknown mode slug to the mode catalog", async () => {
    window.history.pushState({}, "", "/play/not-a-real-mode");

    renderWithProviders(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/game-modes");
    });
    expect(mockedApi.startGame).not.toHaveBeenCalled();
  });

  it("redirects bare /play to the mode catalog", async () => {
    // Without an explicit route this fell through to /:roomCode.
    window.history.pushState({}, "", "/play");

    renderWithProviders(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/game-modes");
    });
  });

  it("emits mode-scoped VideoGame and BreadcrumbList JSON-LD", async () => {
    mockedApi.startGame.mockResolvedValue(makeSession({ id: "s6", gameMode: "higher-lower" }));
    window.history.pushState({}, "", "/play/higher-lower");

    renderWithProviders(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("higher-lower-page")).toBeInTheDocument();
    });

    // Matched by URL rather than by "the first VideoGame blob":
    // react-helmet-async flushes into the shared jsdom head asynchronously,
    // so a previous test's tags can still be present when this one runs.
    const url = "https://price.games/play/higher-lower";
    await waitFor(() => {
      const blobs = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      ).map((el) => JSON.parse(el.textContent ?? "{}"));
      const game = blobs.find((b) => b["@type"] === "VideoGame" && b.url === url);
      const crumbs = blobs.find(
        (b) => b["@type"] === "BreadcrumbList" && b.itemListElement?.[2]?.item === url
      );
      expect(game).toBeDefined();
      expect(game.playMode).toBe("SinglePlayer");
      expect(game.name).toContain("Higher or Lower");
      expect(crumbs).toBeDefined();
      expect(crumbs.itemListElement[1].item).toBe("https://price.games/game-modes");
    });
  });
});
