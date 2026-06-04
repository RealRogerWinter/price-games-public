import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

import { useAdminAuth } from "../context/AdminAuthContext";
import * as adminClient from "../api/adminClient";
import AdminUsersPage from "../pages/admin/AdminUsersPage";

const mockUseAdminAuth = vi.mocked(useAdminAuth);
const mockGetAdminUsers = vi.mocked(adminClient.getAdminUsers);
const mockDeactivateUser = vi.mocked(adminClient.deactivateAdminUser);
const mockReactivateUser = vi.mocked(adminClient.reactivateAdminUser);
const mockDeleteUser = vi.mocked(adminClient.deleteAdminUser);

const mockUsersResponse = {
  users: [
    {
      id: "u1",
      username: "alice",
      email: "alice@test.com",
      isActive: true,
      lifetimeScore: 5000,
      totalGames: 42,
      createdAt: "2026-01-01T00:00:00Z",
      lastLoginAt: "2026-03-15T00:00:00Z",
    },
    {
      id: "u2",
      username: "bob",
      email: "bob@test.com",
      isActive: false,
      lifetimeScore: 1200,
      totalGames: 10,
      createdAt: "2026-02-01T00:00:00Z",
      lastLoginAt: null,
    },
  ],
  total: 2,
  totalPages: 1,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/users"]}>
      <AdminUsersPage />
    </MemoryRouter>
  );
}

async function waitForTable() {
  await waitFor(() => {
    expect(screen.getByTestId("admin-users-page")).toBeInTheDocument();
  });
}

describe("AdminUsersPage — extended coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAdminAuth.mockReturnValue({
      user: {
        id: "1",
        username: "admin",
        createdAt: "",
        updatedAt: "",
        lastLoginAt: null,
        isActive: true,
      },
      isAuthenticated: true,
      loading: false,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
    });
    mockGetAdminUsers.mockResolvedValue(mockUsersResponse as any);
    mockDeactivateUser.mockResolvedValue(undefined as any);
    mockReactivateUser.mockResolvedValue(undefined as any);
    mockDeleteUser.mockResolvedValue(undefined as any);
  });

  // ── Loading state ────────────────────────────────────────────────────────

  it("shows loading spinner initially", () => {
    mockGetAdminUsers.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByTestId("admin-users-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading users...")).toBeInTheDocument();
  });

  // ── Rendering ────────────────────────────────────────────────────────────

  it("renders the users page after data loads", async () => {
    renderPage();
    await waitForTable();
    expect(screen.getByTestId("admin-users-page")).toBeInTheDocument();
  });

  it("shows total user count", async () => {
    renderPage();
    await waitForTable();
    expect(screen.getByText("2 total users")).toBeInTheDocument();
  });

  it("active user shows Deactivate button", async () => {
    renderPage();
    await waitForTable();
    expect(screen.getByTestId("deactivate-u1")).toBeInTheDocument();
    expect(screen.getByTestId("deactivate-u1")).toHaveTextContent("Deactivate");
  });

  it("inactive user shows Reactivate button", async () => {
    renderPage();
    await waitForTable();
    expect(screen.getByTestId("reactivate-u2")).toBeInTheDocument();
    expect(screen.getByTestId("reactivate-u2")).toHaveTextContent("Reactivate");
  });

  it("inactive user last login shows '-'", async () => {
    renderPage();
    await waitForTable();
    // bob has null lastLoginAt — the cell should render "-"
    const cells = screen.getAllByText("-");
    expect(cells.length).toBeGreaterThanOrEqual(1);
  });

  // ── Deactivate ───────────────────────────────────────────────────────────

  it("clicking Deactivate calls deactivateAdminUser and refetches", async () => {
    renderPage();
    await waitForTable();
    await act(async () => {
      fireEvent.click(screen.getByTestId("deactivate-u1"));
    });
    expect(mockDeactivateUser).toHaveBeenCalledWith("u1");
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledTimes(2);
    });
  });

  // ── Reactivate ───────────────────────────────────────────────────────────

  it("clicking Reactivate calls reactivateAdminUser and refetches", async () => {
    renderPage();
    await waitForTable();
    await act(async () => {
      fireEvent.click(screen.getByTestId("reactivate-u2"));
    });
    expect(mockReactivateUser).toHaveBeenCalledWith("u2");
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledTimes(2);
    });
  });

  // ── Delete ───────────────────────────────────────────────────────────────

  it("Delete button shows initially", async () => {
    renderPage();
    await waitForTable();
    expect(screen.getByTestId("delete-u1")).toBeInTheDocument();
    expect(screen.getByTestId("delete-u1")).toHaveTextContent("Delete");
  });

  it("clicking Delete shows Confirm button", async () => {
    renderPage();
    await waitForTable();
    fireEvent.click(screen.getByTestId("delete-u1"));
    expect(screen.getByTestId("confirm-delete-u1")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-delete-u1")).toHaveTextContent("Confirm");
  });

  it("clicking Confirm calls deleteAdminUser and refetches", async () => {
    renderPage();
    await waitForTable();
    fireEvent.click(screen.getByTestId("delete-u1"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-delete-u1"));
    });
    expect(mockDeleteUser).toHaveBeenCalledWith("u1");
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledTimes(2);
    });
  });

  // ── Navigate ─────────────────────────────────────────────────────────────

  it("clicking username navigates to user detail page", async () => {
    renderPage();
    await waitForTable();
    fireEvent.click(screen.getByText("alice"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/users/u1");
  });

  it("clicking second username navigates to correct user detail page", async () => {
    renderPage();
    await waitForTable();
    fireEvent.click(screen.getByText("bob"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/users/u2");
  });

  // ── Search ───────────────────────────────────────────────────────────────

  it("search input updates state and calls API with search param (debounced)", async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await waitForTable();
    const input = screen.getByTestId("users-search-input");
    await user.type(input, "alice");
    await waitFor(
      () => {
        expect(mockGetAdminUsers).toHaveBeenCalledWith(
          expect.objectContaining({ search: "alice" })
        );
      },
      { timeout: 2000 }
    );
  });

  // ── Filter ───────────────────────────────────────────────────────────────

  it("filter by active sends isActive:true to API", async () => {
    renderPage();
    await waitForTable();
    fireEvent.change(screen.getByTestId("users-filter-active"), {
      target: { value: "true" },
    });
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true })
      );
    });
  });

  it("filter by inactive sends isActive:false to API", async () => {
    renderPage();
    await waitForTable();
    fireEvent.change(screen.getByTestId("users-filter-active"), {
      target: { value: "false" },
    });
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false })
      );
    });
  });

  it("selecting 'All Status' removes isActive filter", async () => {
    renderPage();
    await waitForTable();
    // First filter to active
    fireEvent.change(screen.getByTestId("users-filter-active"), {
      target: { value: "true" },
    });
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true })
      );
    });
    // Reset to all
    fireEvent.change(screen.getByTestId("users-filter-active"), {
      target: { value: "all" },
    });
    await waitFor(() => {
      const lastCall = mockGetAdminUsers.mock.calls[mockGetAdminUsers.mock.calls.length - 1][0];
      expect(lastCall).not.toHaveProperty("isActive");
    });
  });

  // ── Sort ─────────────────────────────────────────────────────────────────

  it("clicking a column header changes sortBy", async () => {
    renderPage();
    await waitForTable();
    // Click "Username" header
    fireEvent.click(screen.getByText(/^Username/));
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: "username", sortOrder: "asc" })
      );
    });
  });

  it("clicking the same column header again toggles sort order to desc", async () => {
    renderPage();
    await waitForTable();
    // Click Username to set sortBy = username, sortOrder = asc
    fireEvent.click(screen.getByText(/^Username/));
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: "username", sortOrder: "asc" })
      );
    });
    // Click Username again — should toggle to desc
    fireEvent.click(screen.getByText(/^Username/));
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: "username", sortOrder: "desc" })
      );
    });
  });

  it("clicking a different column header switches sortBy and resets to asc", async () => {
    renderPage();
    await waitForTable();
    // First click Email
    fireEvent.click(screen.getByText(/^Email/));
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: "email", sortOrder: "asc" })
      );
    });
    // Then click Score — should switch column and reset to asc
    fireEvent.click(screen.getByText(/^Score/));
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: "lifetime_score", sortOrder: "asc" })
      );
    });
  });

  it("clicking the 'Joined' column header sorts by created_at", async () => {
    renderPage();
    await waitForTable();
    fireEvent.click(screen.getByText(/^Joined/));
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: "created_at" })
      );
    });
  });

  it("clicking the 'Last Login' column header sorts by last_login_at", async () => {
    renderPage();
    await waitForTable();
    fireEvent.click(screen.getByText(/^Last Login/));
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: "last_login_at" })
      );
    });
  });

  // ── Empty state ──────────────────────────────────────────────────────────

  it("shows 'No users found' when user list is empty", async () => {
    mockGetAdminUsers.mockResolvedValue({
      users: [],
      total: 0,
      totalPages: 0,
    } as any);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("No users found")).toBeInTheDocument();
    });
  });

  // ── Error state ──────────────────────────────────────────────────────────

  it("shows error message when API call fails", async () => {
    mockGetAdminUsers.mockRejectedValue(new Error("Server unavailable"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-error")).toBeInTheDocument();
    });
    expect(screen.getByText("Server unavailable")).toBeInTheDocument();
  });

  it("shows generic error message when non-Error is thrown", async () => {
    mockGetAdminUsers.mockRejectedValue("unknown error");
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-error")).toBeInTheDocument();
    });
    expect(screen.getByText("Failed to load users")).toBeInTheDocument();
  });

  it("Retry button refetches users", async () => {
    mockGetAdminUsers
      .mockRejectedValueOnce(new Error("Oops"))
      .mockResolvedValue(mockUsersResponse as any);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-error")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledTimes(2);
    });
  });

  // ── Pagination ───────────────────────────────────────────────────────────

  it("does not show pagination when totalPages is 1", async () => {
    renderPage();
    await waitForTable();
    expect(screen.queryByTestId("users-pagination")).not.toBeInTheDocument();
  });

  it("shows pagination when totalPages > 1", async () => {
    mockGetAdminUsers.mockResolvedValue({
      ...mockUsersResponse,
      totalPages: 3,
      total: 150,
    } as any);
    renderPage();
    await waitForTable();
    expect(screen.getByTestId("users-pagination")).toBeInTheDocument();
    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
  });

  it("clicking Next page fetches page 2", async () => {
    mockGetAdminUsers.mockResolvedValue({
      ...mockUsersResponse,
      totalPages: 3,
      total: 150,
    } as any);
    renderPage();
    await waitForTable();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    });
    await waitFor(() => {
      expect(mockGetAdminUsers).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2 })
      );
    });
  });

  it("Prev button is disabled on first page", async () => {
    mockGetAdminUsers.mockResolvedValue({
      ...mockUsersResponse,
      totalPages: 3,
      total: 150,
    } as any);
    renderPage();
    await waitForTable();
    expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
  });
});
