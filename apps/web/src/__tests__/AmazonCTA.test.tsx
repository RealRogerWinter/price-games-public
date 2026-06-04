import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AmazonCTA, AMAZON_CTA_LABEL } from "../components/AmazonCTA";

describe("AmazonCTA", () => {
  const HREF = "https://www.amazon.com/dp/B0TESTTEST?tag=pg081-20";

  it("renders an anchor with the expected href, target, and rel", () => {
    render(<AmazonCTA href={HREF} />);
    const link = screen.getByRole("link", { name: /see it on amazon/i });
    expect(link).toHaveAttribute("href", HREF);
    expect(link).toHaveAttribute("target", "_blank");
    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("sponsored");
    expect(rel).toContain("nofollow");
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("uses the generic aria-label when no productLabel is provided", () => {
    render(<AmazonCTA href={HREF} />);
    const link = screen.getByRole("link", { name: /see it on amazon/i });
    expect(link.getAttribute("aria-label")).toBe(
      `${AMAZON_CTA_LABEL} (opens in new tab)`,
    );
  });

  it("includes the productLabel in the aria-label when provided", () => {
    render(<AmazonCTA href={HREF} productLabel="Echo Dot" />);
    const link = screen.getByRole("link", { name: /echo dot/i });
    expect(link.getAttribute("aria-label")).toBe(
      `${AMAZON_CTA_LABEL}: Echo Dot (opens in new tab)`,
    );
  });

  it("fires onAffiliateClick when clicked", () => {
    const spy = vi.fn();
    render(<AmazonCTA href={HREF} onAffiliateClick={spy} />);
    fireEvent.click(screen.getByRole("link", { name: /see it on amazon/i }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("renders the disclosure caption when showDisclosure is true (md button)", () => {
    render(<AmazonCTA href={HREF} showDisclosure />);
    expect(screen.getByText(/affiliate link/i)).toBeInTheDocument();
  });

  it("does not render a disclosure caption by default", () => {
    render(<AmazonCTA href={HREF} />);
    expect(screen.queryByText(/affiliate link/i)).not.toBeInTheDocument();
  });

  it("applies the inline variant classes and omits the shimmer + disclosure", () => {
    const { container } = render(
      <AmazonCTA href={HREF} variant="inline" showDisclosure />,
    );
    const link = screen.getByRole("link", { name: /see it on amazon/i });
    expect(link.className).toContain("amazon-cta--inline");
    expect(link.className).not.toContain("amazon-cta--button");
    expect(container.querySelector(".amazon-cta__shine")).toBeNull();
    // Disclosure is ignored for the inline variant — the caption
    // only belongs with hero/button placements.
    expect(screen.queryByText(/affiliate link/i)).not.toBeInTheDocument();
  });

  it("applies the size modifier for the button variant", () => {
    const { rerender } = render(<AmazonCTA href={HREF} size="md" />);
    expect(
      screen.getByRole("link", { name: /see it on amazon/i }).className,
    ).toContain("amazon-cta--md");
    rerender(<AmazonCTA href={HREF} size="sm" />);
    expect(
      screen.getByRole("link", { name: /see it on amazon/i }).className,
    ).toContain("amazon-cta--sm");
  });

  it("forwards a user-supplied onClick alongside onAffiliateClick", () => {
    const affiliate = vi.fn();
    const user = vi.fn();
    render(
      <AmazonCTA
        href={HREF}
        onAffiliateClick={affiliate}
        onClick={user}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: /see it on amazon/i }));
    expect(affiliate).toHaveBeenCalledTimes(1);
    expect(user).toHaveBeenCalledTimes(1);
  });
});
