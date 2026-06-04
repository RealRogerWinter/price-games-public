import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import AvatarPicker from "../components/AvatarPicker";
import { PROFILE_AVATARS } from "@price-game/shared";

const PAGE_SIZE = 10;

/** Flush the slide animation timers (150ms exit + 200ms enter). */
function flushPageAnimation() {
  act(() => { vi.advanceTimersByTime(150); });
  act(() => { vi.advanceTimersByTime(200); });
}

/** Count how many avatar (not pagination) buttons are currently rendered. */
function getAvatarButtons(): HTMLElement[] {
  return screen.getAllByRole("button").filter((b) => /^Select .* avatar$/.test(b.getAttribute("aria-label") ?? ""));
}

describe("AvatarPicker", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("renders PAGE_SIZE avatars on the first page when none is selected", () => {
    render(<AvatarPicker selected={null} onSelect={vi.fn()} />);
    expect(getAvatarButtons()).toHaveLength(PAGE_SIZE);
  });

  it("renders as a card with a title", () => {
    render(<AvatarPicker selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Choose Your Avatar")).toBeInTheDocument();
  });

  it("opens on the page containing the currently selected avatar and highlights it", () => {
    // 'yeti' sits in the second page of PROFILE_AVATARS, so the picker should
    // open on that page (not page 1) and show yeti as selected.
    render(<AvatarPicker selected="yeti" onSelect={vi.fn()} />);
    const yetiBtn = screen.getByLabelText("Select yeti avatar");
    expect(yetiBtn.classList.contains("avatar-picker-selected")).toBe(true);
  });

  it("does not highlight unselected avatars on the visible page", () => {
    render(<AvatarPicker selected="yeti" onSelect={vi.fn()} />);
    // Pick another avatar from the same (second) page to verify it renders unselected.
    const other = getAvatarButtons().find((b) => b.getAttribute("aria-label") !== "Select yeti avatar");
    expect(other).toBeDefined();
    expect(other!.classList.contains("avatar-picker-selected")).toBe(false);
  });

  it("calls onSelect when an avatar is clicked", () => {
    const onSelect = vi.fn();
    render(<AvatarPicker selected={null} onSelect={onSelect} />);
    // fancy-ghost is in PROFILE_AVATARS[5], so it's on the first page.
    fireEvent.click(screen.getByLabelText("Select fancy-ghost avatar"));
    expect(onSelect).toHaveBeenCalledWith("fancy-ghost");
  });

  it("shows none selected state when avatar is null", () => {
    render(<AvatarPicker selected={null} onSelect={vi.fn()} />);
    const selected = getAvatarButtons().filter((b) => b.classList.contains("avatar-picker-selected"));
    expect(selected).toHaveLength(0);
  });

  it("disables buttons when loading", () => {
    render(<AvatarPicker selected={null} onSelect={vi.fn()} loading />);
    const buttons = screen.getAllByRole("button");
    buttons.forEach((b) => expect(b).toBeDisabled());
  });

  describe("pagination", () => {
    it("renders a page indicator when there are multiple pages", () => {
      const totalPages = Math.ceil(PROFILE_AVATARS.length / PAGE_SIZE);
      render(<AvatarPicker selected={null} onSelect={vi.fn()} />);
      expect(screen.getByText(`Page 1 of ${totalPages}`)).toBeInTheDocument();
    });

    it("disables the prev button on the first page", () => {
      render(<AvatarPicker selected={null} onSelect={vi.fn()} />);
      expect(screen.getByLabelText("Previous avatar page")).toBeDisabled();
    });

    it("advances to the next page when next is clicked", () => {
      render(<AvatarPicker selected={null} onSelect={vi.fn()} />);
      // First page should contain PROFILE_AVATARS[0] ('rain-cloud').
      expect(screen.getByLabelText("Select rain-cloud avatar")).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText("Next avatar page"));
      flushPageAnimation();

      // Second page should show a different slice — 'rain-cloud' is gone,
      // and PROFILE_AVATARS[PAGE_SIZE] should now be visible.
      expect(screen.queryByLabelText("Select rain-cloud avatar")).not.toBeInTheDocument();
      expect(screen.getByLabelText(`Select ${PROFILE_AVATARS[PAGE_SIZE]} avatar`)).toBeInTheDocument();
    });

    it("disables the next button on the last page", () => {
      const totalPages = Math.ceil(PROFILE_AVATARS.length / PAGE_SIZE);
      render(<AvatarPicker selected={null} onSelect={vi.fn()} />);
      for (let i = 0; i < totalPages - 1; i++) {
        fireEvent.click(screen.getByLabelText("Next avatar page"));
        flushPageAnimation();
      }
      expect(screen.getByLabelText("Next avatar page")).toBeDisabled();
    });

    it("returning to a previous page still works", () => {
      render(<AvatarPicker selected={null} onSelect={vi.fn()} />);
      fireEvent.click(screen.getByLabelText("Next avatar page"));
      flushPageAnimation();
      fireEvent.click(screen.getByLabelText("Previous avatar page"));
      flushPageAnimation();
      expect(screen.getByLabelText("Select rain-cloud avatar")).toBeInTheDocument();
      expect(screen.getByLabelText("Previous avatar page")).toBeDisabled();
    });
  });
});
