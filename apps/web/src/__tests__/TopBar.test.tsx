import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { CurrencyProvider } from "../context/CurrencyContext";
import { UserAuthProvider } from "../context/UserAuthContext";
import TopBar from "../components/TopBar";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn().mockRejectedValue(new Error("401")),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

function renderTopBar(props: Partial<React.ComponentProps<typeof TopBar>> = {}) {
  const defaultProps = {
    onGoHome: vi.fn(),
    onApplyCategories: vi.fn(),
    selectedRounds: 5 as const,
    onSelectRounds: vi.fn(),
    ...props,
  };
  return {
    ...render(
      <MemoryRouter>
        <CurrencyProvider>
          <UserAuthProvider>
            <TopBar {...defaultProps} />
          </UserAuthProvider>
        </CurrencyProvider>
      </MemoryRouter>
    ),
    props: defaultProps,
  };
}

describe("TopBar", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders the logo image", () => {
    renderTopBar();
    const logo = screen.getByAltText("price.games");
    expect(logo).toBeInTheDocument();
    expect(logo.tagName).toBe("IMG");
  });

  it("renders New Game button", () => {
    renderTopBar();
    expect(screen.getByText("New Game")).toBeInTheDocument();
  });

  it("renders Options button", () => {
    renderTopBar();
    expect(screen.getByText("Options")).toBeInTheDocument();
  });

  it("calls onGoHome when logo is clicked", () => {
    const { props } = renderTopBar();
    fireEvent.click(screen.getByLabelText("Home"));
    expect(props.onGoHome).toHaveBeenCalledTimes(1);
  });

  it("calls onGoHome when New Game is clicked", () => {
    const { props } = renderTopBar();
    fireEvent.click(screen.getByText("New Game"));
    expect(props.onGoHome).toHaveBeenCalledTimes(1);
  });

  it("opens Options dropdown with Rounds and Currency", () => {
    renderTopBar();
    fireEvent.click(screen.getByText("Options"));
    expect(screen.getByText("Rounds")).toBeInTheDocument();
    expect(screen.getByText("Currency")).toBeInTheDocument();
  });
});
