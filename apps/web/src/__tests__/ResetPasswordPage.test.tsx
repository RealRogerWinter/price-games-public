import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { UserAuthProvider } from "../context/UserAuthContext";
import ResetPasswordPage from "../pages/ResetPasswordPage";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userResetPassword: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import { userGetMe, userResetPassword } from "../api/userClient";
const mockGetMe = vi.mocked(userGetMe);
const mockResetPassword = vi.mocked(userResetPassword);

function renderPage(initialEntries: string[] = ["/reset-password?token=test123"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <UserAuthProvider>
        <ResetPasswordPage />
      </UserAuthProvider>
    </MemoryRouter>
  );
}

describe("ResetPasswordPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMe.mockRejectedValue(new Error("401"));
  });

  it("renders password fields when token is present", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("New Password")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Confirm Password")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reset Password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset Password" })).toBeInTheDocument();
  });

  it("shows error when no token in URL", async () => {
    renderPage(["/reset-password"]);

    await waitFor(() => {
      expect(screen.getByText("Invalid reset link — no token provided.")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Back to Home" })).toBeInTheDocument();
  });

  it("shows error when passwords don't match", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("New Password")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("New Password"), {
      target: { value: "newpassword123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "differentpassword" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset Password" }));

    await waitFor(() => {
      expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
    });
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it("shows success after successful reset", async () => {
    mockResetPassword.mockResolvedValue({ ok: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("New Password")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("New Password"), {
      target: { value: "newSecurePassword123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "newSecurePassword123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset Password" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Your password has been reset successfully. You can now log in with your new password."
        )
      ).toBeInTheDocument();
    });
    expect(mockResetPassword).toHaveBeenCalledWith("test123", "newSecurePassword123");
    expect(screen.getByRole("button", { name: "Go to Login" })).toBeInTheDocument();
  });

  it("shows error on API failure", async () => {
    mockResetPassword.mockRejectedValue(new Error("Token expired"));
    renderPage();

    await waitFor(() => {
      expect(screen.getByLabelText("New Password")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("New Password"), {
      target: { value: "newSecurePassword123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "newSecurePassword123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset Password" }));

    await waitFor(() => {
      expect(screen.getByText("Token expired")).toBeInTheDocument();
    });
  });
});
