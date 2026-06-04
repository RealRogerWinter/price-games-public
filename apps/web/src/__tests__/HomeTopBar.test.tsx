import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CurrencyProvider } from "../context/CurrencyContext";
import { UserAuthProvider } from "../context/UserAuthContext";
import HomeTopBar from "../components/HomeTopBar";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn().mockRejectedValue(new Error("401")),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

function renderBar() {
  return render(
    <MemoryRouter>
      <CurrencyProvider>
        <UserAuthProvider>
          <HomeTopBar />
        </UserAuthProvider>
      </CurrencyProvider>
    </MemoryRouter>,
  );
}

describe("HomeTopBar", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} })),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders inside a .top-bar container so the gameplay CSS applies", () => {
    const { container } = renderBar();
    expect(container.querySelector(".top-bar")).not.toBeNull();
  });

  it("leaves the left slot empty — no logo or New Game", () => {
    renderBar();
    expect(screen.queryByAltText("price.games")).toBeNull();
    expect(screen.queryByText("New Game")).toBeNull();
  });

  it("renders the logged-out auth nav on the right", () => {
    renderBar();
    expect(screen.getByText("Log In")).toBeInTheDocument();
    expect(screen.getByText("Sign Up")).toBeInTheDocument();
  });
});
