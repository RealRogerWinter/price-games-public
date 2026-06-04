import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SharedRoundSnapshot } from "@price-game/shared";
import { CurrencyProvider } from "../context/CurrencyContext";
import SharedRoundCard from "../components/share/SharedRoundCard";

function Wrapper({ children }: { children: React.ReactNode }) {
  return <CurrencyProvider>{children}</CurrencyProvider>;
}

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function buildSnap(
  overrides: Partial<SharedRoundSnapshot> = {},
): SharedRoundSnapshot {
  return {
    roundNumber: 1,
    score: 850,
    products: [
      {
        title: "Echo Dot",
        imageUrl: "https://example.com/echo.jpg",
        priceCents: 4999,
        amazonUrl: "https://amazon.com/dp/B0CX23V2ZK?tag=pricegames-20",
      },
    ],
    ...overrides,
  };
}

describe("SharedRoundCard", () => {
  it("renders the round number and score / max formatted", () => {
    render(
      <SharedRoundCard
        snap={buildSnap()}
        tier="great"
        perRoundMax={1000}
        formatPrice={fmtCents}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText("Round 1")).toBeInTheDocument();
    expect(screen.getByText("850 / 1,000")).toBeInTheDocument();
  });

  it("renders each product with its title, price, and affiliate link", () => {
    render(
      <SharedRoundCard
        snap={buildSnap()}
        tier="great"
        perRoundMax={1000}
        formatPrice={fmtCents}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText("Echo Dot")).toBeInTheDocument();
    expect(screen.getByText("$49.99")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /see it on amazon/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      "href",
      "https://amazon.com/dp/B0CX23V2ZK?tag=pricegames-20",
    );
    expect(link).toHaveAttribute("target", "_blank");
    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("sponsored");
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("omits the Amazon link when amazonUrl is missing", () => {
    render(
      <SharedRoundCard
        snap={buildSnap({
          products: [
            {
              title: "No-Link Product",
              imageUrl: "",
              priceCents: 1000,
            },
          ],
        })}
        tier="ok"
        perRoundMax={1000}
        formatPrice={fmtCents}
      />,
      { wrapper: Wrapper },
    );
    expect(
      screen.queryByRole("link", { name: /see it on amazon/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a 'no product data' placeholder when products is empty", () => {
    render(
      <SharedRoundCard
        snap={buildSnap({ products: [] })}
        tier="miss"
        perRoundMax={1000}
        formatPrice={fmtCents}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText("No product data")).toBeInTheDocument();
  });

  it("renders mode-specific detail rows when the snapshot has them", () => {
    render(
      <SharedRoundCard
        snap={buildSnap({
          guessedPriceCents: 5500,
          wentOver: true,
        })}
        tier="miss"
        perRoundMax={1000}
        formatPrice={fmtCents}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/Guess: \$55\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\(over\)/)).toBeInTheDocument();
  });

  it("renders multiple products when the snap has a basket", () => {
    render(
      <SharedRoundCard
        snap={buildSnap({
          products: [
            { title: "A", imageUrl: "", priceCents: 100, amazonUrl: "https://x/a" },
            { title: "B", imageUrl: "", priceCents: 200, amazonUrl: "https://x/b" },
            { title: "C", imageUrl: "", priceCents: 300 },
          ],
        })}
        tier="good"
        perRoundMax={1000}
        formatPrice={fmtCents}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /see it on amazon/i })).toHaveLength(2);
  });

  it("applies the tier className to the card root", () => {
    const { container } = render(
      <SharedRoundCard
        snap={buildSnap()}
        tier="great"
        perRoundMax={1000}
        formatPrice={fmtCents}
      />,
      { wrapper: Wrapper },
    );
    expect(container.querySelector(".shared-round-card-great")).toBeTruthy();
  });
});
