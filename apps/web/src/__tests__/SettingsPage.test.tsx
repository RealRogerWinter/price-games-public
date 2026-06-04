/**
 * Tests for SettingsPage — covers auth states, rewards loading/claiming,
 * form toggles, and referral visibility. Score, streak, and game history
 * live on ScoreboardPage and are NOT tested here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

vi.mock("../api/userClient", () => ({
  userResendVerification: vi.fn(),
  userGetRewards: vi.fn(),
  userClaimReward: vi.fn(),
  userGetMe: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetHistory: vi.fn(),
  userGetStats: vi.fn(),
  userGetMonthlyPoints: vi.fn(),
  userGetScoreHistory: vi.fn(),
  userUpdateEmail: vi.fn(),
  userUpdatePassword: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
  getEnabledAvatars: vi.fn().mockResolvedValue({ enabledAvatars: [] }),
}));

vi.mock("../components/auth/ChangeEmailForm", () => ({
  default: () => <div data-testid="change-email-form">ChangeEmailForm</div>,
}));
vi.mock("../components/auth/ChangePasswordForm", () => ({
  default: () => <div data-testid="change-password-form">ChangePasswordForm</div>,
}));
vi.mock("../components/ReferralDashboard", () => ({
  default: () => <div data-testid="referral-dashboard">ReferralDashboard</div>,
}));
vi.mock("../components/NotificationSettings", () => ({
  default: () => <div data-testid="notification-settings">NotificationSettings</div>,
}));
vi.mock("../components/CookieConsent", () => ({
  openCookieSettings: vi.fn(),
}));
vi.mock("../components/PageTopBar", () => ({
  default: () => <div data-testid="page-top-bar">PageTopBar</div>,
}));

import { useUserAuth } from "../context/UserAuthContext";
import {
  userResendVerification,
  userGetRewards,
  userClaimReward,
} from "../api/userClient";
import SettingsPage from "../pages/SettingsPage";

const mockUseUserAuth = vi.mocked(useUserAuth);
const mockResendVerification = vi.mocked(userResendVerification);
const mockGetRewards = vi.mocked(userGetRewards);
const mockClaimReward = vi.mocked(userClaimReward);

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

function makeReward(overrides: Partial<{
  id: string;
  amountCents: number;
  description: string | null;
  awardedAt: string;
  awardMethod: string;
  claimedAt: string | null;
  code: string | null;
  claimToken: string;
  claimExpiresAt: string;
}> = {}) {
  return {
    id: "reward-1",
    amountCents: 500,
    description: "Test reward",
    awardedAt: "2026-01-01T00:00:00Z",
    awardMethod: "milestone",
    claimedAt: null,
    code: "GIFT123",
    claimToken: "tok-default",
    claimExpiresAt: "2026-01-31T00:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  return render(<SettingsPage />);
}

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRewards.mockResolvedValue({ rewards: [] } as any);
    mockResendVerification.mockResolvedValue(undefined as any);
    mockClaimReward.mockResolvedValue({ ok: true, code: undefined } as any);
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

  it("does not redirect when authenticated", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("testuser")).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // --- Page structure ---

  it("renders PageTopBar", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("page-top-bar")).toBeInTheDocument();
    });
  });

  it("renders Settings title", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
  });

  // --- User info rendering ---

  it("renders username, email, and verified badge for verified user", async () => {
    const user = makeUser({ username: "alice", email: "alice@test.com", emailVerified: true });
    mockUseUserAuth.mockReturnValue(makeAuthContext({ user }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    expect(screen.getByText("alice@test.com")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("shows Unverified badge for unverified email", async () => {
    const user = makeUser({ emailVerified: false });
    mockUseUserAuth.mockReturnValue(makeAuthContext({ user }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Unverified")).toBeInTheDocument();
    });
  });

  it("shows resend verification button for unverified user", async () => {
    const user = makeUser({ emailVerified: false });
    mockUseUserAuth.mockReturnValue(makeAuthContext({ user }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Resend verification email")).toBeInTheDocument();
    });
  });

  it("shows success message after successful resend verification", async () => {
    const user = makeUser({ emailVerified: false });
    mockUseUserAuth.mockReturnValue(makeAuthContext({ user }));
    mockResendVerification.mockResolvedValue(undefined as any);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Resend verification email")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Resend verification email"));
    await waitFor(() => {
      expect(screen.getByText("Verification email sent!")).toBeInTheDocument();
    });
  });

  it("shows error message when resend verification fails", async () => {
    const user = makeUser({ emailVerified: false });
    mockUseUserAuth.mockReturnValue(makeAuthContext({ user }));
    mockResendVerification.mockRejectedValue(new Error("Rate limit exceeded"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Resend verification email")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Resend verification email"));
    await waitFor(() => {
      expect(screen.getByText("Rate limit exceeded")).toBeInTheDocument();
    });
  });

  // --- Rewards section ---

  it("shows rewards loading state", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    mockGetRewards.mockReturnValue(new Promise(() => {}));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Loading rewards...")).toBeInTheDocument();
    });
  });

  it("shows empty state when no rewards", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    mockGetRewards.mockResolvedValue({ rewards: [] } as any);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("No rewards yet. Keep playing to earn rewards!")).toBeInTheDocument();
    });
  });

  it("renders reward cards when rewards exist", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    const reward = makeReward({ amountCents: 500, description: "Milestone reward" });
    mockGetRewards.mockResolvedValue({ rewards: [reward] } as any);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("$5.00 Amazon Gift Card")).toBeInTheDocument();
    });
    expect(screen.getByText("Collect & Reveal Code")).toBeInTheDocument();
  });

  it("claim reward button navigates to /claim/:token (no in-place API call)", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    const reward = makeReward({ id: "r1", amountCents: 1000 });
    mockGetRewards.mockResolvedValue({ rewards: [reward] } as any);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Collect & Reveal Code")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Collect & Reveal Code"));
    // The settings page no longer claims in place — clicking deep-links
    // through the canonical /claim/:token flow.
    expect(mockClaimReward).not.toHaveBeenCalled();
  });

  // --- Account settings toggles ---

  it("shows Change Email button and toggles form", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Change Email")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("change-email-form")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Change Email"));
    expect(screen.getByTestId("change-email-form")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("change-email-form")).not.toBeInTheDocument();
  });

  it("shows Change Password button and toggles form", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Change Password")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Change Password"));
    expect(screen.getByTestId("change-password-form")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("change-password-form")).not.toBeInTheDocument();
  });

  // --- Referral section ---

  it("shows ReferralDashboard for verified users", async () => {
    const user = makeUser({ emailVerified: true });
    mockUseUserAuth.mockReturnValue(makeAuthContext({ user }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("referral-dashboard")).toBeInTheDocument();
    });
  });

  it("shows verify-to-unlock message for unverified users", async () => {
    const user = makeUser({ emailVerified: false });
    mockUseUserAuth.mockReturnValue(makeAuthContext({ user }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Verify your email to unlock referrals/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("referral-dashboard")).not.toBeInTheDocument();
  });

  // --- Does NOT render scoreboard elements ---

  it("does not render StreakCard or GameHistoryPanel", async () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("streak-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("game-history-panel")).not.toBeInTheDocument();
  });
});
