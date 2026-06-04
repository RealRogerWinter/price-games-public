import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RankBadge from "../components/RankBadge";

describe("RankBadge", () => {
  it("renders the 1st place icon and number for rank 1", () => {
    render(<RankBadge rank={1} />);
    expect(screen.getByLabelText("1st place")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("renders the 2nd place icon for rank 2", () => {
    render(<RankBadge rank={2} />);
    expect(screen.getByLabelText("2nd place")).toBeInTheDocument();
  });

  it("renders the 3rd place icon for rank 3", () => {
    render(<RankBadge rank={3} />);
    expect(screen.getByLabelText("3rd place")).toBeInTheDocument();
  });

  it("renders the top-10 icon for ranks 4–10", () => {
    render(<RankBadge rank={4} />);
    expect(screen.getByLabelText("Top 10 (rank 4)")).toBeInTheDocument();

    render(<RankBadge rank={10} />);
    expect(screen.getByLabelText("Top 10 (rank 10)")).toBeInTheDocument();
  });

  it("renders the standard icon for ranks 11+", () => {
    render(<RankBadge rank={11} />);
    expect(screen.getByLabelText("Rank 11")).toBeInTheDocument();

    render(<RankBadge rank={50} />);
    expect(screen.getByLabelText("Rank 50")).toBeInTheDocument();
  });

  it("defaults to the lifetime variant when no variant is specified", () => {
    const { container } = render(<RankBadge rank={1} />);
    const img = container.querySelector(".rank-badge img") as HTMLImageElement;
    expect(img).toBeTruthy();
    // Lifetime icons live at assets/ranks/rank-*.png — the import hash
    // is unpredictable but the base filename carries through.
    expect(img.getAttribute("src")).toMatch(/rank-1st/);
  });

  it("uses the streak icon set when variant='streak'", () => {
    const { container } = render(<RankBadge rank={1} variant="streak" />);
    const img = container.querySelector(".rank-badge img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toMatch(/streak-1st/);
  });

  it("uses a different icon for variant='streak' vs variant='lifetime'", () => {
    const { container: lifetime } = render(
      <RankBadge rank={1} variant="lifetime" />,
    );
    const { container: streak } = render(<RankBadge rank={1} variant="streak" />);

    const lifetimeSrc = lifetime
      .querySelector(".rank-badge img")!
      .getAttribute("src");
    const streakSrc = streak
      .querySelector(".rank-badge img")!
      .getAttribute("src");

    expect(lifetimeSrc).not.toBe(streakSrc);
    expect(lifetimeSrc).toMatch(/rank-1st/);
    expect(streakSrc).toMatch(/streak-1st/);
  });

  it("applies the provided size to the rendered image", () => {
    const { container } = render(<RankBadge rank={1} size={64} />);
    const img = container.querySelector(".rank-badge img") as HTMLImageElement;
    expect(img.getAttribute("width")).toBe("64");
    expect(img.getAttribute("height")).toBe("64");
  });

  it("always shows the numeric rank next to the icon", () => {
    render(<RankBadge rank={42} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});
