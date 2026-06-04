import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../context/AdminAuthContext", () => {
  const actual = vi.importActual("../context/AdminAuthContext");
  return {
    ...actual,
    AdminAuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useAdminAuth: vi.fn(),
  };
});

vi.mock("../pages/admin/AdminLoginPage", () => ({
  default: () => <div data-testid="admin-login-page">AdminLoginPage</div>,
}));

vi.mock("../pages/admin/AdminDashboard", () => ({
  default: () => <div data-testid="admin-dashboard">AdminDashboard</div>,
}));

vi.mock("../pages/admin/AdminUsersPage", () => ({
  default: () => <div data-testid="admin-users-page">AdminUsersPage</div>,
}));

vi.mock("../pages/admin/AdminUserDetailPage", () => ({
  default: () => <div data-testid="admin-user-detail-page">AdminUserDetailPage</div>,
}));

vi.mock("../pages/admin/AdminLegalPage", () => ({
  default: () => <div data-testid="admin-legal-page">AdminLegalPage</div>,
}));

// CSS import is a no-op in tests (vitest css: false), but mock to be safe
vi.mock("../pages/admin/admin.css", () => ({}));

import { useAdminAuth } from "../context/AdminAuthContext";
import AdminApp from "../pages/admin/AdminApp";

const mockUseAdminAuth = vi.mocked(useAdminAuth);

/**
 * Renders AdminApp inside a MemoryRouter at the given path,
 * mounted under /admin/* to mirror the real App routing.
 */
function renderAdminApp(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("AdminApp", () => {
  const defaultAuth = {
    user: null,
    isAuthenticated: false,
    loading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
  };

  beforeEach(() => {
    mockUseAdminAuth.mockReturnValue({ ...defaultAuth });
  });

  it("renders login page at /admin/login when not authenticated", () => {
    renderAdminApp("/admin/login");

    expect(screen.getByTestId("admin-login-page")).toBeInTheDocument();
  });

  it("renders dashboard at /admin when authenticated", () => {
    mockUseAdminAuth.mockReturnValue({
      ...defaultAuth,
      user: { id: "1", username: "admin", createdAt: "", updatedAt: "", lastLoginAt: null, isActive: true },
      isAuthenticated: true,
    });

    renderAdminApp("/admin");

    expect(screen.getByTestId("admin-dashboard")).toBeInTheDocument();
  });

  it("redirects /admin to /admin/login when not authenticated", () => {
    renderAdminApp("/admin");

    // Should show login page since user is not authenticated
    expect(screen.queryByTestId("admin-dashboard")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-login-page")).toBeInTheDocument();
  });

  it("redirects /admin/login to /admin when already authenticated", () => {
    mockUseAdminAuth.mockReturnValue({
      ...defaultAuth,
      user: { id: "1", username: "admin", createdAt: "", updatedAt: "", lastLoginAt: null, isActive: true },
      isAuthenticated: true,
    });

    renderAdminApp("/admin/login");

    // Should show dashboard since user is already authenticated
    expect(screen.queryByTestId("admin-login-page")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-dashboard")).toBeInTheDocument();
  });

  it("shows loading state while checking auth", () => {
    mockUseAdminAuth.mockReturnValue({
      ...defaultAuth,
      loading: true,
    });

    renderAdminApp("/admin");

    expect(screen.getByText("Checking session...")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-login-page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("admin-dashboard")).not.toBeInTheDocument();
  });
});
