import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { UserAuthProvider } from "../context/UserAuthContext";
import VerifyEmailPage from "../pages/VerifyEmailPage";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userVerifyEmail: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import { userGetMe, userVerifyEmail } from "../api/userClient";
const mockGetMe = vi.mocked(userGetMe);
const mockVerifyEmail = vi.mocked(userVerifyEmail);

function renderPage(initialEntries: string[] = ["/verify-email"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <UserAuthProvider>
        <VerifyEmailPage />
      </UserAuthProvider>
    </MemoryRouter>
  );
}

describe("VerifyEmailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMe.mockRejectedValue(new Error("401"));
  });

  it("shows loading initially when token is present", () => {
    // Keep the promise pending so the component stays in loading state
    mockVerifyEmail.mockReturnValue(new Promise(() => {}));
    renderPage(["/verify-email?token=valid-token"]);

    expect(screen.getByText("Verifying your email...")).toBeInTheDocument();
  });

  it("shows success when token is valid", async () => {
    mockVerifyEmail.mockResolvedValue({ ok: true });
    renderPage(["/verify-email?token=valid-token"]);

    await waitFor(() => {
      expect(screen.getByText("Your email has been verified successfully!")).toBeInTheDocument();
    });
    expect(mockVerifyEmail).toHaveBeenCalledWith("valid-token");
    expect(screen.getByRole("button", { name: "Go to Home" })).toBeInTheDocument();
  });

  it("shows error when no token in URL", async () => {
    renderPage(["/verify-email"]);

    await waitFor(() => {
      expect(screen.getByText("No verification token provided")).toBeInTheDocument();
    });
    expect(mockVerifyEmail).not.toHaveBeenCalled();
  });

  it("shows error when verification fails", async () => {
    mockVerifyEmail.mockRejectedValue(new Error("Token expired"));
    renderPage(["/verify-email?token=bad-token"]);

    await waitFor(() => {
      expect(screen.getByText("Token expired")).toBeInTheDocument();
    });
    expect(mockVerifyEmail).toHaveBeenCalledWith("bad-token");
    expect(screen.getByRole("button", { name: "Go to Home" })).toBeInTheDocument();
  });
});
