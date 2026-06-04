import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import UserNavBar from "../components/auth/UserNavBar";
import { makeUser } from "./testUtils";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import { userGetMe, userLogout } from "../api/userClient";
const mockGetMe = vi.mocked(userGetMe);
const mockLogout = vi.mocked(userLogout);

import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { UserAuthProvider } from "../context/UserAuthContext";

function renderUserNavBar() {
  return render(
    <MemoryRouter>
      <UserAuthProvider>
        <UserNavBar />
      </UserAuthProvider>
    </MemoryRouter>
  );
}

describe("UserNavBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Log In and Sign Up buttons when logged out", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    renderUserNavBar();

    await waitFor(() => {
      expect(screen.getByText("Log In")).toBeInTheDocument();
    });
    expect(screen.getByText("Sign Up")).toBeInTheDocument();
  });

  it("shows username and Log Out when logged in", async () => {
    mockGetMe.mockResolvedValue({ user: makeUser({ username: "alice" }) });
    renderUserNavBar();

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    expect(screen.getByText("Log Out")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("opens login modal when Log In is clicked", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    renderUserNavBar();

    await waitFor(() => {
      expect(screen.getByText("Log In")).toBeInTheDocument();
    });

    // Click the nav bar's Log In button (not from the form)
    fireEvent.click(screen.getByText("Log In"));

    // The modal should show the login form with the Email or Username field
    expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
  });

  it("opens register modal when Sign Up is clicked", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    renderUserNavBar();

    await waitFor(() => {
      expect(screen.getByText("Sign Up")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Sign Up"));

    expect(screen.getByRole("heading", { name: "Create Account" })).toBeInTheDocument();
  });

  it("calls logout when Log Out is clicked", async () => {
    mockGetMe.mockResolvedValue({ user: makeUser() });
    mockLogout.mockResolvedValue(undefined);
    renderUserNavBar();

    await waitFor(() => {
      expect(screen.getByText("Log Out")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Log Out"));

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });
  });

  it("shows avatar icon when user has an avatar set", async () => {
    mockGetMe.mockResolvedValue({ user: makeUser({ username: "alice", avatar: "yeti" }) });
    renderUserNavBar();

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    expect(screen.getByRole("img", { name: "Cozy Yeti" })).toBeInTheDocument();
  });

  it("does not show avatar icon when avatar is null", async () => {
    mockGetMe.mockResolvedValue({ user: makeUser({ username: "bob", avatar: null }) });
    renderUserNavBar();

    await waitFor(() => {
      expect(screen.getByText("bob")).toBeInTheDocument();
    });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
