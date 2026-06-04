import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../context/UserAuthContext", () => ({
  useUserAuth: vi.fn(() => ({ isAuthenticated: false, user: null })),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: vi.fn(() => vi.fn()),
}));

import { useUserAuth } from "../context/UserAuthContext";
import { useNavigate } from "react-router-dom";
import type { PromoBanner } from "@price-game/shared";
import GiveawayModal from "../components/GiveawayModal";
import { makeUser } from "./testUtils";

const defaultBanner: PromoBanner = {
  enabled: true,
  text: "Win a prize!",
  linkText: "Learn More",
  linkUrl: "/settings",
  audienceMode: "all",
  showLink: true,
  showGiveawayModal: true,
  giveawayMinPoints: 20000,
  giveawayMinStreak: 0,
  giveawayQualifyMode: "points_only",
  showTracker: true,
  qualifiedMessage: "You're in!",
};

describe("GiveawayModal", () => {
  const onClose = vi.fn();
  const onOpenRegister = vi.fn();
  const mockNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUserAuth).mockReturnValue({ isAuthenticated: false, user: null });
    vi.mocked(useNavigate).mockReturnValue(mockNavigate);
  });

  it("renders the modal overlay with correct data-testid", () => {
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    expect(screen.getByTestId("giveaway-modal")).toBeInTheDocument();
  });

  it("renders the modal title", () => {
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    expect(screen.getByText("Monthly Giveaway")).toBeInTheDocument();
  });

  it("renders 4 giveaway rule steps", () => {
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    const ruleNumbers = screen.getAllByText(/^[1-4]$/);
    expect(ruleNumbers).toHaveLength(4);
  });

  it("renders rule step content: create account, verify email, earn points, get entered", () => {
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    expect(screen.getByText("Create an account")).toBeInTheDocument();
    expect(screen.getByText("Verify your email")).toBeInTheDocument();
    expect(screen.getByText("Earn points")).toBeInTheDocument();
    expect(screen.getByText("Get entered into the drawing")).toBeInTheDocument();
  });

  it("closes modal when Escape key is pressed", () => {
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes modal when overlay is clicked", () => {
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    fireEvent.click(screen.getByTestId("giveaway-modal"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close modal when content area is clicked (stopPropagation)", () => {
    const { container } = render(
      <GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />
    );
    const content = container.querySelector(".giveaway-modal-content");
    expect(content).toBeTruthy();
    fireEvent.click(content!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows Sign Up button when user is not authenticated", () => {
    vi.mocked(useUserAuth).mockReturnValue({ isAuthenticated: false, user: null });
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    expect(screen.getByTestId("giveaway-signup-btn")).toBeInTheDocument();
    expect(screen.getByText("Sign Up")).toBeInTheDocument();
  });

  it("Sign Up button calls onClose then onOpenRegister", () => {
    vi.mocked(useUserAuth).mockReturnValue({ isAuthenticated: false, user: null });
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    fireEvent.click(screen.getByTestId("giveaway-signup-btn"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenRegister).toHaveBeenCalledTimes(1);
  });

  it("does not show verify or all-set CTAs when user is not authenticated", () => {
    vi.mocked(useUserAuth).mockReturnValue({ isAuthenticated: false, user: null });
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    expect(screen.queryByTestId("giveaway-verify-btn")).not.toBeInTheDocument();
    expect(screen.queryByText(/You're all set/)).not.toBeInTheDocument();
  });

  it("shows Go to Settings button when authenticated but email not verified", () => {
    vi.mocked(useUserAuth).mockReturnValue({
      isAuthenticated: true,
      user: makeUser({ emailVerified: false }),
    });
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    expect(screen.getByTestId("giveaway-verify-btn")).toBeInTheDocument();
    expect(screen.getByText("Go to Settings")).toBeInTheDocument();
  });

  it("Go to Settings button calls onClose and navigates to /settings", () => {
    vi.mocked(useUserAuth).mockReturnValue({
      isAuthenticated: true,
      user: makeUser({ emailVerified: false }),
    });
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    fireEvent.click(screen.getByTestId("giveaway-verify-btn"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/settings");
  });

  it("does not show Sign Up button when authenticated but unverified", () => {
    vi.mocked(useUserAuth).mockReturnValue({
      isAuthenticated: true,
      user: makeUser({ emailVerified: false }),
    });
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    expect(screen.queryByTestId("giveaway-signup-btn")).not.toBeInTheDocument();
  });

  it("shows 'You're all set!' message when authenticated and email verified", () => {
    vi.mocked(useUserAuth).mockReturnValue({
      isAuthenticated: true,
      user: makeUser({ emailVerified: true }),
    });
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    expect(screen.getByText(/You're all set!/)).toBeInTheDocument();
  });

  it("does not show Sign Up or Go to Settings buttons when authenticated and verified", () => {
    vi.mocked(useUserAuth).mockReturnValue({
      isAuthenticated: true,
      user: makeUser({ emailVerified: true }),
    });
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    expect(screen.queryByTestId("giveaway-signup-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("giveaway-verify-btn")).not.toBeInTheDocument();
  });

  it("close button calls onClose", () => {
    render(<GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />);
    // The button's visible glyph is "×" but its accessible name is the
    // aria-label "Close" — aria-label wins for screen readers and for
    // testing-library's role queries.
    const closeBtn = screen.getByRole("button", { name: "Close" });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("removes Escape key listener on unmount", () => {
    const { unmount } = render(
      <GiveawayModal banner={defaultBanner} onClose={onClose} onOpenRegister={onOpenRegister} />
    );
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  // ── Qualification copy branching by banner.giveawayQualifyMode ────────────
  describe("qualification copy", () => {
    it("points_only: renders 'Earn points' headline", () => {
      render(
        <GiveawayModal
          banner={{ ...defaultBanner, giveawayQualifyMode: "points_only", giveawayMinPoints: 20000 }}
          onClose={onClose}
          onOpenRegister={onOpenRegister}
        />
      );
      const rule = screen.getByTestId("giveaway-rule-qualify");
      expect(rule).toHaveTextContent("Earn points");
      expect(rule).toHaveTextContent(/current calendar month/);
    });

    it("streak_only: renders 'Keep a daily streak' copy with threshold", () => {
      render(
        <GiveawayModal
          banner={{ ...defaultBanner, giveawayQualifyMode: "streak_only", giveawayMinStreak: 7 }}
          onClose={onClose}
          onOpenRegister={onOpenRegister}
        />
      );
      const rule = screen.getByTestId("giveaway-rule-qualify");
      expect(rule).toHaveTextContent("Keep a daily streak");
      expect(rule).toHaveTextContent("7 days");
      // Fine-print bullet should also reflect streak rule
      expect(screen.getByTestId("giveaway-fine-print-qualify")).toHaveTextContent("7 days");
    });

    it("points_and_streak: mentions both thresholds with AND", () => {
      render(
        <GiveawayModal
          banner={{
            ...defaultBanner,
            giveawayQualifyMode: "points_and_streak",
            giveawayMinPoints: 10000,
            giveawayMinStreak: 5,
          }}
          onClose={onClose}
          onOpenRegister={onOpenRegister}
        />
      );
      const rule = screen.getByTestId("giveaway-rule-qualify");
      expect(rule).toHaveTextContent("AND");
      expect(rule).toHaveTextContent("10,000");
      expect(rule).toHaveTextContent("5 days");
    });

    it("points_or_streak: mentions both thresholds with OR", () => {
      render(
        <GiveawayModal
          banner={{
            ...defaultBanner,
            giveawayQualifyMode: "points_or_streak",
            giveawayMinPoints: 15000,
            giveawayMinStreak: 3,
          }}
          onClose={onClose}
          onOpenRegister={onOpenRegister}
        />
      );
      const rule = screen.getByTestId("giveaway-rule-qualify");
      expect(rule).toHaveTextContent("OR");
      expect(rule).toHaveTextContent("15,000");
      expect(rule).toHaveTextContent("3 days");
    });

    it("singular 'day' for streak of 1", () => {
      render(
        <GiveawayModal
          banner={{ ...defaultBanner, giveawayQualifyMode: "streak_only", giveawayMinStreak: 1 }}
          onClose={onClose}
          onOpenRegister={onOpenRegister}
        />
      );
      expect(screen.getByTestId("giveaway-rule-qualify")).toHaveTextContent("1 day ");
    });
  });
});
