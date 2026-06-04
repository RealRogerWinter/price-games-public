import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { UserAuthProvider } from "../context/UserAuthContext";
import ForgotPasswordPage from "../pages/ForgotPasswordPage";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userForgotPassword: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import { userGetMe, userForgotPassword } from "../api/userClient";
const mockGetMe = vi.mocked(userGetMe);
const mockForgotPassword = vi.mocked(userForgotPassword);

function renderPage() {
  return render(
    <MemoryRouter>
      <UserAuthProvider>
        <ForgotPasswordPage />
      </UserAuthProvider>
    </MemoryRouter>
  );
}

describe("ForgotPasswordPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMe.mockRejectedValue(new Error("401"));
  });

  it("renders email input and submit button", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Send Reset Link" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reset Password" })).toBeInTheDocument();
  });

  it("submit is disabled when email is empty", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });
    const submitBtn = screen.getByRole("button", { name: "Send Reset Link" });
    expect(submitBtn).toBeDisabled();
  });

  it("shows success message after submission", async () => {
    mockForgotPassword.mockResolvedValue({ ok: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Link" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "If an account exists with that email, we've sent a password reset link. Check your inbox."
        )
      ).toBeInTheDocument();
    });
    expect(mockForgotPassword).toHaveBeenCalledWith("user@example.com");
    expect(screen.getByRole("button", { name: "Back to Home" })).toBeInTheDocument();
  });

  it("shows error on failure", async () => {
    mockForgotPassword.mockRejectedValue(new Error("Network error"));
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Link" }));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });
});
