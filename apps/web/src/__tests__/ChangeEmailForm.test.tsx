import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import ChangeEmailForm from "../components/auth/ChangeEmailForm";
import { makeUser } from "./testUtils";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userUpdateEmail: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import { userGetMe, userUpdateEmail } from "../api/userClient";
const mockGetMe = vi.mocked(userGetMe);
const mockUpdateEmail = vi.mocked(userUpdateEmail);

import { render } from "@testing-library/react";
import { UserAuthProvider } from "../context/UserAuthContext";

function renderChangeEmailForm() {
  return render(
    <UserAuthProvider>
      <ChangeEmailForm />
    </UserAuthProvider>
  );
}

describe("ChangeEmailForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMe.mockResolvedValue({ user: makeUser() });
  });

  it("renders email and password fields", async () => {
    renderChangeEmailForm();
    await waitFor(() => {
      expect(screen.getByLabelText("New Email")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Current Password")).toBeInTheDocument();
  });

  it("shows validation error on email blur with invalid value", async () => {
    renderChangeEmailForm();
    await waitFor(() => {
      expect(screen.getByLabelText("New Email")).toBeInTheDocument();
    });

    const emailInput = screen.getByLabelText("New Email");
    fireEvent.change(emailInput, { target: { value: "notvalid" } });
    fireEvent.blur(emailInput);

    expect(screen.getByText("Please enter a valid email address")).toBeInTheDocument();
  });

  it("disables submit when fields are empty", async () => {
    renderChangeEmailForm();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Update Email" })).toBeDisabled();
    });
  });

  it("submits and shows success message", async () => {
    const updatedUser = makeUser({ email: "new@example.com" });
    mockUpdateEmail.mockResolvedValue({ user: updatedUser });
    renderChangeEmailForm();
    await waitFor(() => {
      expect(screen.getByLabelText("New Email")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("New Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Current Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("New Email").closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("Email updated successfully")).toBeInTheDocument();
    });
    expect(mockUpdateEmail).toHaveBeenCalledWith("new@example.com", "password123!");
  });

  it("shows error message on failure", async () => {
    mockUpdateEmail.mockRejectedValue(new Error("Invalid password"));
    renderChangeEmailForm();
    await waitFor(() => {
      expect(screen.getByLabelText("New Email")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("New Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Current Password"), { target: { value: "wrong" } });
    fireEvent.submit(screen.getByLabelText("New Email").closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("Invalid password")).toBeInTheDocument();
    });
  });
});
