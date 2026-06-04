import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import IdentityCard from "../components/IdentityCard";
import { renderWithProviders } from "./testUtils";

beforeEach(() => {
  localStorage.clear();
  // UserAuthProvider's mount-time userGetMe() needs a deterministic 401 so
  // the loading flag resolves; the IdentityCard renders nothing until then.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
  );
});

describe("IdentityCard (anonymous)", () => {
  it("renders the guest CTA copy and a generated handle", async () => {
    const onOpenRegister = vi.fn();
    renderWithProviders(<IdentityCard onOpenRegister={onOpenRegister} />);

    await waitFor(() => {
      expect(screen.getByText("Playing as guest")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Make an account to select your name and avatar."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign up/i })).toBeInTheDocument();
    // The generated handle is two capitalized words separated by a space.
    const handle = screen.getByRole("button").querySelector(".id-card-name");
    expect(handle?.textContent).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("invokes onOpenRegister when tapped", async () => {
    const onOpenRegister = vi.fn();
    renderWithProviders(<IdentityCard onOpenRegister={onOpenRegister} />);

    const button = await screen.findByRole("button", { name: /sign up/i });
    fireEvent.click(button);
    expect(onOpenRegister).toHaveBeenCalledOnce();
  });

  it("reuses the persisted guest identity across remounts", async () => {
    const { unmount } = renderWithProviders(
      <IdentityCard onOpenRegister={() => {}} />,
    );
    const firstHandle = (
      await screen.findByRole("button", { name: /sign up/i })
    ).querySelector(".id-card-name")?.textContent;
    unmount();

    renderWithProviders(<IdentityCard onOpenRegister={() => {}} />);
    const secondHandle = (
      await screen.findByRole("button", { name: /sign up/i })
    ).querySelector(".id-card-name")?.textContent;
    expect(secondHandle).toBe(firstHandle);
  });

  it("renders the displayNameOverride as the name while keeping the guest CTA", async () => {
    renderWithProviders(
      <IdentityCard onOpenRegister={() => {}} displayNameOverride="MyCustomName" />,
    );
    const button = await screen.findByRole("button", { name: /sign up/i });
    expect(button.querySelector(".id-card-name")?.textContent).toBe("MyCustomName");
    expect(screen.getByText("Playing as guest")).toBeInTheDocument();
    expect(
      screen.getByText("Make an account to select your name and avatar."),
    ).toBeInTheDocument();
  });

  it("ignores a blank displayNameOverride and falls back to the guest handle", async () => {
    renderWithProviders(
      <IdentityCard onOpenRegister={() => {}} displayNameOverride="   " />,
    );
    const button = await screen.findByRole("button", { name: /sign up/i });
    expect(button.querySelector(".id-card-name")?.textContent).toMatch(
      /^[A-Z][a-z]+ [A-Z][a-z]+$/,
    );
  });
});
