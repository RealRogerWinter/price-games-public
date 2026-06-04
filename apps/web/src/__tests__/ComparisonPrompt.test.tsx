import { describe, it, expect } from "vitest";
import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import ComparisonPrompt from "../components/ComparisonPrompt";

describe("ComparisonPrompt", () => {
  it("renders MORE word and up glyph for most-expensive question", () => {
    render(<ComparisonPrompt question="most-expensive" roundKey={1} />);
    expect(screen.getByText("MORE")).toBeInTheDocument();
    expect(screen.getByTestId("comparison-prompt-glyph")).toHaveTextContent("▲");
  });

  it("renders LESS word and down glyph for least-expensive question", () => {
    render(<ComparisonPrompt question="least-expensive" roundKey={1} />);
    expect(screen.getByText("LESS")).toBeInTheDocument();
    expect(screen.getByTestId("comparison-prompt-glyph")).toHaveTextContent("▼");
  });

  it("renders the helper sentence framing the question", () => {
    render(<ComparisonPrompt question="most-expensive" roundKey={1} />);
    expect(screen.getByText(/Which product is/)).toBeInTheDocument();
    expect(screen.getByText(/expensive\?/)).toBeInTheDocument();
  });

  it("exposes the active question on the wrapper via data-question", () => {
    const { container, rerender } = render(
      <ComparisonPrompt question="most-expensive" roundKey={1} />
    );
    expect(container.querySelector('[data-question="most-expensive"]')).not.toBeNull();
    rerender(<ComparisonPrompt question="least-expensive" roundKey={2} />);
    expect(container.querySelector('[data-question="least-expensive"]')).not.toBeNull();
  });

  it("does not flag data-flipped on first render", () => {
    const { container } = render(
      <ComparisonPrompt question="most-expensive" roundKey={1} />
    );
    const wrapper = container.querySelector(".comparison-prompt") as HTMLElement;
    expect(wrapper.dataset.flipped).not.toBe("true");
  });

  it("flags data-flipped='true' when question changes between renders", () => {
    const { container, rerender } = render(
      <ComparisonPrompt question="most-expensive" roundKey={1} />
    );
    rerender(<ComparisonPrompt question="least-expensive" roundKey={2} />);
    const wrapper = container.querySelector(".comparison-prompt") as HTMLElement;
    expect(wrapper.dataset.flipped).toBe("true");
  });

  it("does NOT flag data-flipped when only the round key changes (same direction)", () => {
    const { container, rerender } = render(
      <ComparisonPrompt question="most-expensive" roundKey={1} />
    );
    rerender(<ComparisonPrompt question="most-expensive" roundKey={2} />);
    const wrapper = container.querySelector(".comparison-prompt") as HTMLElement;
    expect(wrapper.dataset.flipped).not.toBe("true");
  });

  it("re-mounts the hero element when roundKey changes (so CSS animation re-fires)", () => {
    const { container, rerender } = render(
      <ComparisonPrompt question="most-expensive" roundKey={1} />
    );
    const firstHero = container.querySelector(".comparison-prompt__hero");
    rerender(<ComparisonPrompt question="most-expensive" roundKey={2} />);
    const secondHero = container.querySelector(".comparison-prompt__hero");
    expect(firstHero).not.toBe(secondHero);
  });

  it("emits an aria-live region announcing the prompt for screen readers", () => {
    const { container } = render(
      <ComparisonPrompt question="most-expensive" roundKey={3} />
    );
    const live = container.querySelector('[aria-live]') as HTMLElement;
    expect(live).not.toBeNull();
    expect(live.textContent?.toLowerCase()).toContain("more");
    expect(live.textContent?.toLowerCase()).toContain("expensive");
  });

  it("falls back to MORE for an unknown question value", () => {
    render(<ComparisonPrompt question="banana" roundKey={1} />);
    expect(screen.getByText("MORE")).toBeInTheDocument();
  });

  it("flip detection survives React StrictMode double-rendering", () => {
    // Regression: an earlier implementation mutated a ref during render,
    // which under StrictMode dev double-invocation read the same value
    // twice and silently set flipped=false on every flip.
    const { container, rerender } = render(
      <StrictMode>
        <ComparisonPrompt question="most-expensive" roundKey={1} />
      </StrictMode>
    );
    rerender(
      <StrictMode>
        <ComparisonPrompt question="least-expensive" roundKey={2} />
      </StrictMode>
    );
    const wrapper = container.querySelector(".comparison-prompt") as HTMLElement;
    expect(wrapper.dataset.flipped).toBe("true");
  });
});
