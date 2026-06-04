import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SignupCtaCard from "../components/SignupCtaCard";

describe("SignupCtaCard", () => {
  it("score variant personalizes the headline with the player's score", () => {
    render(<SignupCtaCard variant="score" score={2500} onSignup={vi.fn()} />);
    expect(screen.getByText(/Claim your/i)).toBeInTheDocument();
    expect(screen.getByText("2,500")).toBeInTheDocument();
    expect(screen.getByText(/points/i)).toBeInTheDocument();
  });

  it("score variant falls back to 'Save this game' when score is 0", () => {
    render(<SignupCtaCard variant="score" score={0} onSignup={vi.fn()} />);
    expect(screen.getByText(/Save this game to your account/i)).toBeInTheDocument();
  });

  it("streak variant shows streak-focused headline", () => {
    render(<SignupCtaCard variant="streak" onSignup={vi.fn()} />);
    expect(screen.getByText(/Save your daily streak/i)).toBeInTheDocument();
  });

  it("multiplayer variant uses the shared score headline", () => {
    render(<SignupCtaCard variant="multiplayer" score={1200} onSignup={vi.fn()} />);
    expect(screen.getByText(/Claim your/i)).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
  });

  it("invokes onSignup when the button is clicked", () => {
    const onSignup = vi.fn();
    render(<SignupCtaCard variant="score" score={500} onSignup={onSignup} />);
    fireEvent.click(screen.getByRole("button", { name: /Create free account/i }));
    expect(onSignup).toHaveBeenCalledTimes(1);
  });

  it("treasure chest image is aria-hidden for screen readers", () => {
    const { container } = render(
      <SignupCtaCard variant="score" score={100} onSignup={vi.fn()} />,
    );
    const img = container.querySelector("img.signup-claim-cta-img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(img).toHaveAttribute("alt", "");
  });
});
