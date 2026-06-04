import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  AreaChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="recharts-area-chart">{children}</div>
  ),
  Area: () => <div data-testid="recharts-area" />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  Tooltip: () => <div />,
  CartesianGrid: () => <div />,
}));

vi.mock("../context/AdminAuthContext", () => ({
  useAdminAuth: vi.fn(),
}));

vi.mock("../api/adminClient", () => ({
  getAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  deactivateAdminUser: vi.fn(),
  reactivateAdminUser: vi.fn(),
  deleteAdminUser: vi.fn(),
  resetAdminUserPassword: vi.fn(),
  getAdminUserGameHistory: vi.fn(),
  getAdminUserStats: vi.fn(),
  getAdminUserActivity: vi.fn(),
}));

import { useAdminAuth } from "../context/AdminAuthContext";
import * as adminClient from "../api/adminClient";
import AdminUserDetailPage from "../pages/admin/AdminUserDetailPage";

const mockUseAdminAuth = vi.mocked(useAdminAuth);
const mockGetUser = vi.mocked(adminClient.getAdminUser);
const mockUpdateUser = vi.mocked(adminClient.updateAdminUser);
const mockResetPassword = vi.mocked(adminClient.resetAdminUserPassword);
const mockGetHistory = vi.mocked(adminClient.getAdminUserGameHistory);
const mockGetStats = vi.mocked(adminClient.getAdminUserStats);
const mockGetActivity = vi.mocked(adminClient.getAdminUserActivity);

const mockUser = {
  id: "u1",
  username: "alice",
  email: "alice@test.com",
  isActive: true,
  lifetimeScore: 5000,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-03-01T00:00:00Z",
  lastLoginAt: "2026-03-15T10:00:00Z",
  emailVerified: true,
  oauthProvider: null,
  totalGames: 50,
};

const mockStats = {
  totalGames: 50,
  totalScore: 100000,
  bestScore: 8500,
  averageScore: 2000,
  gamesByMode: { classic: 30, "higher-lower": 20 },
  multiplayerWins: 5,
};

const mockHistory = {
  history: [
    { id: 1, gameType: "single" as const, gameMode: "classic", score: 5000, placement: null, playersCount: null, playedAt: "2026-03-15T10:00:00Z" },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

const mockActivity = [
  { date: "2026-03-14", gamesPlayed: 3 },
  { date: "2026-03-15", gamesPlayed: 5 },
];

function renderWithRouter(userId = "u1") {
  return render(
    <MemoryRouter initialEntries={[`/admin/users/${userId}`]}>
      <Routes>
        <Route path="/admin/users/:id" element={<AdminUserDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function setupMocks() {
  mockGetUser.mockResolvedValue(mockUser);
  mockGetStats.mockResolvedValue(mockStats);
  mockGetHistory.mockResolvedValue(mockHistory);
  mockGetActivity.mockResolvedValue(mockActivity);
}

describe("AdminUserDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAdminAuth.mockReturnValue({
      user: { id: "1", username: "admin", createdAt: "", updatedAt: "", lastLoginAt: null, isActive: true },
      isAuthenticated: true, loading: false, error: null, login: vi.fn(), logout: vi.fn(),
    });
  });

  it("renders user profile info", async () => {
    setupMocks();
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("user-detail-page")).toBeInTheDocument();
    });
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("alice@test.com")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    mockGetUser.mockReturnValue(new Promise(() => {}));
    mockGetStats.mockReturnValue(new Promise(() => {}));
    mockGetHistory.mockReturnValue(new Promise(() => {}));
    mockGetActivity.mockReturnValue(new Promise(() => {}));
    renderWithRouter();
    expect(screen.getByText("Loading user...")).toBeInTheDocument();
  });

  it("shows error for non-existent user", async () => {
    mockGetUser.mockRejectedValue(new Error("User not found"));
    mockGetStats.mockRejectedValue(new Error("User not found"));
    mockGetHistory.mockRejectedValue(new Error("User not found"));
    mockGetActivity.mockRejectedValue(new Error("User not found"));
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText(/User not found/)).toBeInTheDocument();
    });
  });

  it("renders user stats section", async () => {
    setupMocks();
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("user-stats-grid")).toBeInTheDocument();
    });
    const grid = screen.getByTestId("user-stats-grid");
    expect(within(grid).getByText("Total Games")).toBeInTheDocument();
    expect(within(grid).getByText("50")).toBeInTheDocument();
    expect(within(grid).getByText("Best Score")).toBeInTheDocument();
    expect(within(grid).getByText("8,500")).toBeInTheDocument();
  });

  it("renders game history table", async () => {
    setupMocks();
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("user-game-history")).toBeInTheDocument();
    });
    const historySection = screen.getByTestId("user-game-history");
    expect(within(historySection).getByText("classic")).toBeInTheDocument();
    expect(within(historySection).getByText("5,000")).toBeInTheDocument();
  });

  it("renders activity chart", async () => {
    setupMocks();
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("user-activity-chart")).toBeInTheDocument();
    });
  });

  it("reset password shows temporary password", async () => {
    setupMocks();
    mockResetPassword.mockResolvedValue({ temporaryPassword: "TempPass123xyz" });
    const user = userEvent.setup();
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("btn-reset-password")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("btn-reset-password"));
    await waitFor(() => {
      expect(screen.getByText("TempPass123xyz")).toBeInTheDocument();
    });
  });

  it("edit form saves changes", async () => {
    setupMocks();
    mockUpdateUser.mockResolvedValue({ ...mockUser, username: "alice_new" });
    const user = userEvent.setup();
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-user")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("btn-edit-user"));
    const usernameInput = screen.getByTestId("edit-username");
    await user.clear(usernameInput);
    await user.type(usernameInput, "alice_new");
    await user.click(screen.getByTestId("btn-save-user"));
    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith("u1", expect.objectContaining({ username: "alice_new" }));
    });
  });
});
