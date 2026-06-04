import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../context/AdminAuthContext", () => {
  const actual = vi.importActual("../context/AdminAuthContext");
  return {
    ...actual,
    useAdminAuth: vi.fn(),
  };
});

import { useAdminAuth } from "../context/AdminAuthContext";
import AdminLoginPage from "../pages/admin/AdminLoginPage";

const mockUseAdminAuth = vi.mocked(useAdminAuth);

describe("AdminLoginPage", () => {
  const mockLogin = vi.fn();
  const mockLogout = vi.fn();

  beforeEach(() => {
    mockLogin.mockReset();
    mockLogout.mockReset();
    mockUseAdminAuth.mockReturnValue({
      user: null,
      isAuthenticated: false,
      loading: false,
      error: null,
      login: mockLogin,
      logout: mockLogout,
    });
  });

  it("renders username and password inputs", () => {
    render(<AdminLoginPage />);

    expect(screen.getByPlaceholderText("Username")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
  });

  it("renders login button", () => {
    render(<AdminLoginPage />);

    expect(screen.getByRole("button", { name: "Sign In" })).toBeInTheDocument();
  });

  it("disables button when fields are empty", () => {
    render(<AdminLoginPage />);

    const button = screen.getByRole("button", { name: "Sign In" });
    expect(button).toBeDisabled();
  });

  it("calls login() on form submit with username and password", async () => {
    mockLogin.mockResolvedValue(undefined);
    render(<AdminLoginPage />);

    fireEvent.change(screen.getByPlaceholderText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "secret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith("admin", "secret123");
    });
  });

  it("shows error message when login fails", () => {
    mockUseAdminAuth.mockReturnValue({
      user: null,
      isAuthenticated: false,
      loading: false,
      error: "Invalid credentials",
      login: mockLogin,
      logout: mockLogout,
    });

    render(<AdminLoginPage />);

    expect(screen.getByTestId("admin-login-error")).toHaveTextContent(
      "Invalid credentials"
    );
  });

  it("shows loading state during login", () => {
    mockUseAdminAuth.mockReturnValue({
      user: null,
      isAuthenticated: false,
      loading: true,
      error: null,
      login: mockLogin,
      logout: mockLogout,
    });

    render(<AdminLoginPage />);

    // Inputs should be disabled when authLoading is true
    expect(screen.getByTestId("admin-login-username")).toBeDisabled();
    expect(screen.getByTestId("admin-login-password")).toBeDisabled();
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByRole("button")).toHaveTextContent("Signing in...");
  });

  it("does not render form when already authenticated", () => {
    mockUseAdminAuth.mockReturnValue({
      user: {
        id: "1",
        username: "admin",
        createdAt: "",
        updatedAt: "",
        lastLoginAt: null,
      },
      isAuthenticated: true,
      loading: false,
      error: null,
      login: mockLogin,
      logout: mockLogout,
    });

    render(<AdminLoginPage />);

    // Component returns null when authenticated
    expect(screen.queryByTestId("admin-login-form")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign In" })
    ).not.toBeInTheDocument();
  });

  it("enables button when both fields are filled", () => {
    render(<AdminLoginPage />);

    fireEvent.change(screen.getByPlaceholderText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "password" },
    });

    const button = screen.getByRole("button", { name: "Sign In" });
    expect(button).toBeEnabled();
  });
});
