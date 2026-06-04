import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import AuthModal from "../components/auth/AuthModal";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import { userGetMe } from "../api/userClient";
const mockGetMe = vi.mocked(userGetMe);

import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { UserAuthProvider } from "../context/UserAuthContext";

function renderAuthModal(props: { onClose: () => void; initialMode?: "login" | "register" }) {
  return render(
    <MemoryRouter>
      <UserAuthProvider>
        <AuthModal {...props} />
      </UserAuthProvider>
    </MemoryRouter>
  );
}

describe("AuthModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMe.mockRejectedValue(new Error("401"));
  });

  it("renders login form by default", async () => {
    renderAuthModal({ onClose: vi.fn() });
    await waitFor(() => {
      expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    });
    // The h2 title should say "Log In"
    expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
  });

  it("renders register form when initialMode is register", async () => {
    renderAuthModal({ onClose: vi.fn(), initialMode: "register" });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create Account" })).toBeInTheDocument();
    });
  });

  it("switches from login to register when Register link is clicked", async () => {
    renderAuthModal({ onClose: vi.fn() });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Register"));

    expect(screen.getByRole("heading", { name: "Create Account" })).toBeInTheDocument();
  });

  it("switches from register to login when Log In link is clicked", async () => {
    renderAuthModal({ onClose: vi.fn(), initialMode: "register" });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create Account" })).toBeInTheDocument();
    });

    // Click the "Log In" link (in the auth-switch section, not the submit button)
    const loginLinks = screen.getAllByText("Log In");
    // The link is the btn-link button type
    const linkBtn = loginLinks.find((el) => el.classList.contains("btn-link"));
    fireEvent.click(linkBtn!);

    expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
  });

  it("calls onClose when overlay is clicked", async () => {
    const onClose = vi.fn();
    renderAuthModal({ onClose });
    await waitFor(() => {
      expect(screen.getByTestId("auth-modal-overlay")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("auth-modal-overlay"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when content is clicked", async () => {
    const onClose = vi.fn();
    renderAuthModal({ onClose });
    await waitFor(() => {
      expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    });

    // Click on the form content (the label is inside the modal content)
    fireEvent.click(screen.getByLabelText("Email or Username"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn();
    renderAuthModal({ onClose });
    await waitFor(() => {
      expect(screen.getByLabelText("Email or Username")).toBeInTheDocument();
    });

    // The close button has class auth-modal-close
    const closeBtn = document.querySelector(".auth-modal-close") as HTMLElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
