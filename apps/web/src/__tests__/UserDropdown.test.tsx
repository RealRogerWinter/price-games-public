import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { makeUser } from "./testUtils";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../context/UserAuthContext", () => ({
  useUserAuth: vi.fn(),
}));

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import { useUserAuth } from "../context/UserAuthContext";
import { render } from "@testing-library/react";
import UserDropdown from "../components/auth/UserDropdown";

const mockUseUserAuth = vi.mocked(useUserAuth);

function makeAuthContext(overrides: Partial<ReturnType<typeof useUserAuth>> = {}) {
  return {
    user: makeUser(),
    isAuthenticated: true,
    loading: false,
    error: null,
    oauthProviders: { google: false, facebook: false, amazon: false },
    refreshUser: vi.fn(),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    register: vi.fn(),
    updateUser: vi.fn(),
    usernamePending: false,
    ...overrides,
  } as ReturnType<typeof useUserAuth>;
}

describe("UserDropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Log In and Sign Up when logged out", () => {
    mockUseUserAuth.mockReturnValue(
      makeAuthContext({ user: null, isAuthenticated: false })
    );
    render(<UserDropdown />);
    expect(screen.getByText("Log In")).toBeInTheDocument();
    expect(screen.getByText("Sign Up")).toBeInTheDocument();
  });

  it("shows avatar and username trigger when logged in", () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    render(<UserDropdown />);
    expect(screen.getByText("testuser")).toBeInTheDocument();
    // Should NOT show menu items until dropdown is opened
    expect(screen.queryByText("My Scores")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Log Out")).not.toBeInTheDocument();
  });

  it("opens dropdown with Scoreboard, Settings, and Log Out on trigger click", () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    render(<UserDropdown />);
    fireEvent.click(screen.getByText("testuser"));
    expect(screen.getByText("My Scores")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Log Out")).toBeInTheDocument();
  });

  it("shows username and email in dropdown header", () => {
    const user = makeUser({ username: "alice", email: "alice@test.com" });
    mockUseUserAuth.mockReturnValue(makeAuthContext({ user }));
    render(<UserDropdown />);
    fireEvent.click(screen.getByText("alice"));
    expect(screen.getByText("alice@test.com")).toBeInTheDocument();
  });

  it("navigates to /scoreboard when Scoreboard is clicked", () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    render(<UserDropdown />);
    fireEvent.click(screen.getByText("testuser"));
    fireEvent.click(screen.getByText("My Scores"));
    expect(mockNavigate).toHaveBeenCalledWith("/scoreboard");
  });

  it("navigates to /settings when Settings is clicked", () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    render(<UserDropdown />);
    fireEvent.click(screen.getByText("testuser"));
    fireEvent.click(screen.getByText("Settings"));
    expect(mockNavigate).toHaveBeenCalledWith("/settings");
  });

  it("calls logout when Log Out is clicked", async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    mockUseUserAuth.mockReturnValue(makeAuthContext({ logout }));
    render(<UserDropdown />);
    fireEvent.click(screen.getByText("testuser"));
    fireEvent.click(screen.getByText("Log Out"));
    await waitFor(() => {
      expect(logout).toHaveBeenCalledTimes(1);
    });
  });

  it("closes dropdown on Escape key", () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    render(<UserDropdown />);
    fireEvent.click(screen.getByText("testuser"));
    expect(screen.getByText("Settings")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("closes dropdown on outside click", () => {
    mockUseUserAuth.mockReturnValue(makeAuthContext());
    render(<UserDropdown />);
    fireEvent.click(screen.getByText("testuser"));
    expect(screen.getByText("Settings")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });
});
