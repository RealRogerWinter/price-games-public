import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../context/AdminAuthContext", () => ({
  useAdminAuth: vi.fn(),
}));

vi.mock("../api/adminClient", () => ({
  getAdminUsers: vi.fn(),
  deactivateAdminUser: vi.fn(),
  reactivateAdminUser: vi.fn(),
  deleteAdminUser: vi.fn(),
}));

import { useAdminAuth } from "../context/AdminAuthContext";
import * as adminClient from "../api/adminClient";
import AdminUsersPage from "../pages/admin/AdminUsersPage";

const mockUseAdminAuth = vi.mocked(useAdminAuth);
const mockGetAdminUsers = vi.mocked(adminClient.getAdminUsers);
const mockDeactivateUser = vi.mocked(adminClient.deactivateAdminUser);
const mockDeleteUser = vi.mocked(adminClient.deleteAdminUser);

const mockUsers = {
  users: [
    {
      id: "u1",
      username: "alice",
      email: "alice@test.com",
      isActive: true,
      lifetimeScore: 5000,
      createdAt: "2026-01-01T00:00:00Z",
      lastLoginAt: "2026-03-15T10:00:00Z",
      totalGames: 50,
    },
    {
      id: "u2",
      username: "bob",
      email: "bob@test.com",
      isActive: false,
      lifetimeScore: 3000,
      createdAt: "2026-02-01T00:00:00Z",
      lastLoginAt: null,
      totalGames: 20,
    },
  ],
  total: 2,
  page: 1,
  pageSize: 50,
  totalPages: 1,
};

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <AdminUsersPage />
    </MemoryRouter>
  );
}

describe("AdminUsersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAdminAuth.mockReturnValue({
      user: { id: "1", username: "admin", createdAt: "", updatedAt: "", lastLoginAt: null, isActive: true },
      isAuthenticated: true, loading: false, error: null, login: vi.fn(), logout: vi.fn(),
    });
  });

  it("renders user list table", async () => {
    mockGetAdminUsers.mockResolvedValue(mockUsers);
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-table")).toBeInTheDocument();
    });
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    mockGetAdminUsers.mockReturnValue(new Promise(() => {}));
    renderWithRouter();
    expect(screen.getByText("Loading users...")).toBeInTheDocument();
  });

  it("shows error state", async () => {
    mockGetAdminUsers.mockRejectedValue(new Error("Network error"));
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
    });
  });

  it("displays user columns", async () => {
    mockGetAdminUsers.mockResolvedValue(mockUsers);
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-table")).toBeInTheDocument();
    });
    const table = screen.getByTestId("admin-users-table");
    expect(within(table).getByText("Username")).toBeInTheDocument();
    expect(within(table).getByText("Email")).toBeInTheDocument();
    expect(within(table).getByText("Status")).toBeInTheDocument();
    expect(within(table).getByText("Score")).toBeInTheDocument();
    expect(within(table).getByText("Games")).toBeInTheDocument();
  });

  it("search input calls API with search param", async () => {
    mockGetAdminUsers.mockResolvedValue(mockUsers);
    const user = userEvent.setup();
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-table")).toBeInTheDocument();
    });
    const searchInput = screen.getByTestId("users-search-input");
    await user.type(searchInput, "alice");
    // Debounced search should fire
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ search: "alice" })
      );
    }, { timeout: 2000 });
  });

  it("shows empty state when no users", async () => {
    mockGetAdminUsers.mockResolvedValue({
      users: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
    });
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText("No users found")).toBeInTheDocument();
    });
  });

  it("shows active/inactive status badges", async () => {
    mockGetAdminUsers.mockResolvedValue(mockUsers);
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-table")).toBeInTheDocument();
    });
    const table = screen.getByTestId("admin-users-table");
    expect(within(table).getByText("Active")).toBeInTheDocument();
    expect(within(table).getByText("Inactive")).toBeInTheDocument();
  });
});
