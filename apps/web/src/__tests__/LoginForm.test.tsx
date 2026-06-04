import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import LoginForm from "../components/auth/LoginForm";
import { makeUser } from "./testUtils";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn(),
}));

import { userGetMe, userLogin, userGetOAuthProviders } from "../api/userClient";
const mockGetMe = vi.mocked(userGetMe);
const mockLogin = vi.mocked(userLogin);
const mockGetOAuthProviders = vi.mocked(userGetOAuthProviders);

// We need to render LoginForm inside UserAuthProvider
import { render } from "@testing-library/react";
import { UserAuthProvider } from "../context/UserAuthContext";

function renderLoginForm() {
  const onSwitchToRegister = vi.fn();
  const result = render(
    <UserAuthProvider>
      <LoginForm onSwitchToRegister={onSwitchToRegister} />
    </UserAuthProvider>
  );
  return { ...result, onSwitchToRegister };
}

describe("LoginForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMe.mockRejectedValue(new Error("401"));
    mockGetOAuthProviders.mockResolvedValue({ google: false, facebook: false });
  });

  it("renders login form with identifier and password fields", async () => {
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("disables submit button when fields are empty", async () => {
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
    });
    const submitBtn = screen.getByRole("button", { name: "Log In" });
    expect(submitBtn).toBeDisabled();
  });

  it("enables submit button when both fields have values", async () => {
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Email or Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    expect(screen.getByRole("button", { name: "Log In" })).toBeEnabled();
  });

  it("calls login on submit with stayLoggedIn unchecked by default", async () => {
    mockLogin.mockResolvedValue({ user: makeUser() });
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Email or Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Email or Username").closest("form")!);

    await waitFor(() => {
      // Default: checkbox is unchecked → session cookie (stayLoggedIn=false)
      expect(mockLogin).toHaveBeenCalledWith("testuser", "password123!", false);
    });
  });

  // ── Stay logged in checkbox ─────────────────────────────────────────
  // The checkbox is the only UI toggle that flips the cookie from a
  // session cookie to a persistent 30-day cookie. It must default to
  // unchecked (opt-in) to match standard "remember me" UX on shared
  // devices, and its value must reach the login() call verbatim so the
  // server can decide what to set in Set-Cookie.

  it("renders a 'Stay logged in' checkbox that is unchecked by default", async () => {
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    });
    const checkbox = screen.getByLabelText("Stay logged in") as HTMLInputElement;
    expect(checkbox).toBeInTheDocument();
    expect(checkbox.type).toBe("checkbox");
    expect(checkbox.checked).toBe(false);
  });

  it("passes stayLoggedIn=true to login() when the checkbox is checked", async () => {
    mockLogin.mockResolvedValue({ user: makeUser() });
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Email or Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.click(screen.getByLabelText("Stay logged in"));
    fireEvent.submit(screen.getByLabelText("Email or Username").closest("form")!);

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith("testuser", "password123!", true);
    });
  });

  it("displays error on login failure", async () => {
    mockLogin.mockRejectedValue(new Error("Invalid credentials"));
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Email or Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrongpass12" } });
    fireEvent.submit(screen.getByLabelText("Email or Username").closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });
  });

  it("shows loading state during submit", async () => {
    mockLogin.mockReturnValue(new Promise(() => {}));
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Email or Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Email or Username").closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("Logging in...")).toBeInTheDocument();
    });
  });

  it("shows Register link that calls onSwitchToRegister", async () => {
    const { onSwitchToRegister } = renderLoginForm();
    await waitFor(() => {
      expect(screen.getByText("Register")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Register"));
    expect(onSwitchToRegister).toHaveBeenCalledOnce();
  });

  // ── OAuth button visibility ─────────────────────────────────────────

  it("hides OAuth buttons when no providers are configured", async () => {
    mockGetOAuthProviders.mockResolvedValue({ google: false, facebook: false });
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Continue with Google")).not.toBeInTheDocument();
    expect(screen.queryByText("Continue with Facebook")).not.toBeInTheDocument();
  });

  it("shows Google button when Google is configured", async () => {
    mockGetOAuthProviders.mockResolvedValue({ google: true, facebook: false });
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByText("Continue with Google")).toBeInTheDocument();
    });
    expect(screen.queryByText("Continue with Facebook")).not.toBeInTheDocument();
  });

  it("shows Facebook button when Facebook is configured", async () => {
    mockGetOAuthProviders.mockResolvedValue({ google: false, facebook: true });
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByText("Continue with Facebook")).toBeInTheDocument();
    });
    expect(screen.queryByText("Continue with Google")).not.toBeInTheDocument();
  });

  it("shows both OAuth buttons when both are configured", async () => {
    mockGetOAuthProviders.mockResolvedValue({ google: true, facebook: true });
    renderLoginForm();
    await waitFor(() => {
      expect(screen.getByText("Continue with Google")).toBeInTheDocument();
    });
    expect(screen.getByText("Continue with Facebook")).toBeInTheDocument();
  });
});
