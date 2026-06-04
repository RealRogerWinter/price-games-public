/**
 * Tests for ScoreboardPage — covers auth states, rendering of
 * lifetime score, StreakCard, and GameHistoryPanel.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeUser } from "./testUtils";

const mockNavigate = vi.fn();
const mockRefreshUser = vi.fn().mockResolvedValue(undefined);

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ hash: "", key: "test" }),
  Link: ({ to, children, ...rest }: any) => <a href={to} {...rest}>{children}</a>,
}));

vi.mock("../context/UserAuthContext", () => ({
  useUserAuth: vi.fn(),
}));

vi.mock("../components/GameHistoryPanel", () => ({
  default: () => <div data-testid="game-history-panel">GameHistoryPanel</div>,
}));
vi.mock("../components/StreakCard", () => ({
  default: () => <div data-testid="streak-card">StreakCard</div>,
}));
vi.mock("../components/PageTopBar", () => ({
  default: () => <div data-testid="page-top-bar">PageTopBar</div>,
}));

import { useUserAuth } from "../context/UserAuthContext";
import ScoreboardPage from "../pages/ScoreboardPage";

const mockUseUserAuth = vi.mocked(useUserAuth);

function makeAuthContext(overrides: Partial<ReturnType<typeof useUserAuth>> = {}) {
  return {
    user: makeUser(),
    isAuthenticated: true,
    loading: false,
    error: null,
    oauthProviders: { google: false, facebook: false, amazon: false },
    refreshUser: mockRefreshUser,
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
    updateUser: vi.fn(),
    usernamePending: false,
    ...overrides,
  } as ReturnType<typeof useUserAuth>;
}

function renderPage() {
  return render(<ScoreboardPage />);
}

describe("ScoreboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Auth / loading states ---

  it("shows loading state when auth is loading", () => {
    mockUseUserAuth.mockReturnValue(
      makeAuthContext({ loading: true, user: null, isAuthenticated: false })
    );
    renderPage();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("returns null when user is null and not loading", () => {
    mockUseUserAuth.mockReturnValue(
      makeAuthContext({ loading: false, user: null, isAuthenticated: false })
    );
    const { container } = renderPage();
    expect(container.querySelector(".profile-page")).not.toBeInTheDocument();
  });

  it("redirects to '/' when not authenticated", () => {
    mockUseUserAuth.mockReturnValue(
      makeAuthContext({ loading: false, user: null, isAuthenticated: false })
    );
    renderPage();
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  // --- Content rendering ---

  it("renders PageTopBar", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("page-top-bar")).toBeInTheDocument();
    });
  });

  it("renders My Scores title", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("My Scores")).toBeInTheDocument();
    });
  });

  it("renders lifetime score", async () => {
    const user = makeUser({ lifetimeScore: 42500 });
    mockUseUserAuth.mockReturnValue(makeAuthContext({ user }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("42,500")).toBeInTheDocument();
    });
  });

  it("renders StreakCard", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("streak-card")).toBeInTheDocument();
    });
  });

  it("renders GameHistoryPanel", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("game-history-panel")).toBeInTheDocument();
    });
  });

  it("calls refreshUser on mount when authenticated", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(mockRefreshUser).toHaveBeenCalled();
    });
  });
});
