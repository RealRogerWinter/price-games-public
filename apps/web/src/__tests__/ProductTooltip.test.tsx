import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import ProductTooltip from "../components/ProductTooltip";
import { renderWithProviders, makeProduct, makeProductWithPrice } from "./testUtils";
import type { Product, ProductWithPrice } from "@price-game/shared";

// =============================================================================
// Environment stubs
// =============================================================================

/**
 * jsdom does not provide window.matchMedia. We install a stub before each test
 * with a mutable flag controlling whether `(hover: none)` matches, so
 * individual tests can simulate "desktop with hover" vs. "touch-only"
 * contexts without leaking state between tests.
 */
let matchesHoverNone = false;
beforeEach(() => {
  matchesHoverNone = false;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(hover: none)" ? matchesHoverNone : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// =============================================================================
// Helpers
// =============================================================================

function renderTooltip(
  product: Product | ProductWithPrice,
  opts: { disabled?: boolean } = {}
) {
  return renderWithProviders(
    <ProductTooltip product={product} disabled={opts.disabled}>
      <span data-testid="trigger">{product.title}</span>
    </ProductTooltip>
  );
}

/** Opens the tooltip by hovering the trigger and advancing past the open delay. */
function openViaHover() {
  fireEvent.mouseEnter(screen.getByTestId("trigger"));
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

// =============================================================================
// Mount / render
// =============================================================================

describe("ProductTooltip — mount/render", () => {
  it("renders its child as the trigger without wrapping it in an extra element", () => {
    const product = makeProductWithPrice({ title: "Widget" });
    const { container } = renderWithProviders(
      <div data-testid="wrapper">
        <ProductTooltip product={product}>
          <span data-testid="trigger">Widget</span>
        </ProductTooltip>
      </div>
    );
    const wrapper = container.querySelector('[data-testid="wrapper"]');
    expect(wrapper).not.toBeNull();
    // The only child of wrapper should be the <span> trigger itself —
    // no injected <span>/<div> wrapper from ProductTooltip.
    expect(wrapper!.children.length).toBe(1);
    expect(wrapper!.firstElementChild?.tagName).toBe("SPAN");
    expect(wrapper!.firstElementChild?.getAttribute("data-testid")).toBe("trigger");
  });

  it("does not render the tooltip card initially", () => {
    renderTooltip(makeProductWithPrice());
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
  });
});

// =============================================================================
// Desktop hover path
// =============================================================================

describe("ProductTooltip — desktop hover", () => {
  it("shows tooltip after mouseenter + open delay", () => {
    vi.useFakeTimers();
    renderTooltip(makeProductWithPrice());
    fireEvent.mouseEnter(screen.getByTestId("trigger"));
    // Before the 150ms delay elapses: not yet shown
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
  });

  it("hides tooltip after mouseleave + close grace", () => {
    vi.useFakeTimers();
    renderTooltip(makeProductWithPrice());
    const trigger = screen.getByTestId("trigger");
    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
    fireEvent.mouseLeave(trigger);
    // Still visible during the close-grace window
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
  });

  it("stays open when the pointer moves from the trigger into the tooltip card", () => {
    vi.useFakeTimers();
    renderTooltip(makeProductWithPrice());
    const trigger = screen.getByTestId("trigger");
    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const tooltip = screen.getByRole("group", { name: /product preview/i });
    fireEvent.mouseLeave(trigger);
    // Cursor enters the tooltip before the close grace expires
    fireEvent.mouseEnter(tooltip);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
  });

  it("focus on the trigger shows the tooltip; blur hides it", () => {
    vi.useFakeTimers();
    renderTooltip(makeProductWithPrice());
    const trigger = screen.getByTestId("trigger");
    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
    fireEvent.blur(trigger);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
  });
});

// =============================================================================
// Touch tap path
// =============================================================================

describe("ProductTooltip — touch tap", () => {
  it("tap on trigger shows the tooltip on touch devices", () => {
    matchesHoverNone = true;
    renderTooltip(makeProductWithPrice());
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
  });

  it("tap on trigger a second time hides the tooltip", () => {
    matchesHoverNone = true;
    renderTooltip(makeProductWithPrice());
    const trigger = screen.getByTestId("trigger");
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
  });

  it("tap outside the tooltip closes it", () => {
    matchesHoverNone = true;
    renderTooltip(makeProductWithPrice());
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
  });

  it("touch tap on trigger does not bubble click to ancestor button", () => {
    matchesHoverNone = true;
    const onAncestorClick = vi.fn();
    renderWithProviders(
      <button type="button" onClick={onAncestorClick} data-testid="ancestor">
        <ProductTooltip product={makeProductWithPrice()}>
          <span data-testid="trigger">Widget</span>
        </ProductTooltip>
      </button>
    );
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
    // The ancestor button must NOT receive the click — otherwise tapping a
    // product title inside a "submit guess" card would submit the guess.
    expect(onAncestorClick).not.toHaveBeenCalled();
  });

  it("mouseenter does NOT open the tooltip on touch devices", () => {
    matchesHoverNone = true;
    vi.useFakeTimers();
    renderTooltip(makeProductWithPrice());
    fireEvent.mouseEnter(screen.getByTestId("trigger"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
  });
});

// =============================================================================
// Keyboard & a11y
// =============================================================================

describe("ProductTooltip — keyboard & a11y", () => {
  it("Escape key closes an open tooltip", () => {
    vi.useFakeTimers();
    renderTooltip(makeProductWithPrice());
    openViaHover();
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
  });

  it("tooltip has role=group and aria-label='Product preview'", () => {
    vi.useFakeTimers();
    renderTooltip(makeProductWithPrice());
    openViaHover();
    const tooltip = screen.getByRole("group", { name: /product preview/i });
    expect(tooltip).toHaveAttribute("aria-label", "Product preview");
    expect(tooltip).toHaveAttribute("role", "group");
  });

  it("trigger advertises the popup via aria-haspopup='dialog'", () => {
    renderTooltip(makeProductWithPrice());
    const trigger = screen.getByTestId("trigger");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("trigger receives aria-describedby equal to tooltip id while open", () => {
    vi.useFakeTimers();
    renderTooltip(makeProductWithPrice());
    const trigger = screen.getByTestId("trigger");
    expect(trigger).not.toHaveAttribute("aria-describedby");
    openViaHover();
    const tooltip = screen.getByRole("group", { name: /product preview/i });
    const id = tooltip.getAttribute("id");
    expect(id).toBeTruthy();
    expect(trigger).toHaveAttribute("aria-describedby", id!);
  });
});

// =============================================================================
// Content rendering
// =============================================================================

describe("ProductTooltip — content", () => {
  it("renders the product image with alt text equal to the title", () => {
    vi.useFakeTimers();
    const product = makeProductWithPrice({
      title: "Widget Pro",
      imageUrl: "https://m.media-amazon.com/images/widget.jpg",
    });
    renderTooltip(product);
    openViaHover();
    const img = screen.getByAltText("Widget Pro");
    expect(img).toHaveAttribute(
      "src",
      "https://m.media-amazon.com/images/widget.jpg"
    );
  });

  it("renders formatted price when product has priceCents", () => {
    vi.useFakeTimers();
    const product = makeProductWithPrice({ priceCents: 2000 });
    renderTooltip(product);
    openViaHover();
    // Default currency in jsdom is USD (localStorage empty), so 2000¢ → $20.00
    expect(screen.getByText("$20.00")).toBeInTheDocument();
  });

  it("shows '$???' placeholder when product has no priceCents (mid-round)", () => {
    vi.useFakeTimers();
    const product = makeProduct({ title: "No Price Widget" });
    renderTooltip(product);
    openViaHover();
    expect(screen.getByText("$???")).toBeInTheDocument();
  });

  it("renders the category", () => {
    vi.useFakeTimers();
    const product = makeProductWithPrice({ category: "Electronics" });
    renderTooltip(product);
    openViaHover();
    expect(screen.getByText("Electronics")).toBeInTheDocument();
  });

  it("renders a 'See it on Amazon' link with affiliate URL when amazonUrl is set", () => {
    vi.useFakeTimers();
    const product = makeProductWithPrice({
      amazonUrl: "https://www.amazon.com/dp/B0TESTTEST?tag=pg081-20",
    });
    renderTooltip(product);
    openViaHover();
    const link = screen.getByRole("link", { name: /see it on amazon/i });
    expect(link).toHaveAttribute(
      "href",
      "https://www.amazon.com/dp/B0TESTTEST?tag=pg081-20"
    );
    expect(link).toHaveAttribute("target", "_blank");
    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("omits the Amazon CTA when amazonUrl is undefined", () => {
    vi.useFakeTimers();
    const product = makeProductWithPrice({ amazonUrl: undefined });
    renderTooltip(product);
    openViaHover();
    expect(
      screen.queryByRole("link", { name: /see it on amazon/i })
    ).toBeNull();
  });

  it("omits the Amazon CTA when showAmazonLink={false} even if amazonUrl is set", () => {
    vi.useFakeTimers();
    const product = makeProductWithPrice({
      amazonUrl: "https://www.amazon.com/dp/B0TESTTEST?tag=pg081-20",
    });
    renderWithProviders(
      <ProductTooltip product={product} showAmazonLink={false}>
        <span data-testid="trigger">{product.title}</span>
      </ProductTooltip>
    );
    fireEvent.mouseEnter(screen.getByTestId("trigger"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Tooltip is open but the CTA is suppressed (mid-round spoiler guard)
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /see it on amazon/i })
    ).toBeNull();
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe("ProductTooltip — edge cases", () => {
  it("disabled prop prevents the tooltip from opening on hover", () => {
    vi.useFakeTimers();
    renderTooltip(makeProductWithPrice(), { disabled: true });
    fireEvent.mouseEnter(screen.getByTestId("trigger"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
  });

  it("disabled prop prevents the tooltip from opening on tap", () => {
    matchesHoverNone = true;
    renderTooltip(makeProductWithPrice(), { disabled: true });
    fireEvent.click(screen.getByTestId("trigger"));
    expect(screen.queryByRole("group", { name: /product preview/i })).toBeNull();
  });

  it("placement='top' renders with the product-tooltip-top class", () => {
    vi.useFakeTimers();
    renderWithProviders(
      <ProductTooltip product={makeProductWithPrice()} placement="top">
        <span data-testid="trigger">Widget</span>
      </ProductTooltip>
    );
    fireEvent.mouseEnter(screen.getByTestId("trigger"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const tooltip = screen.getByRole("group", { name: /product preview/i });
    expect(tooltip.className).toContain("product-tooltip-top");
    expect(tooltip.className).not.toContain("product-tooltip-bottom");
  });

  it("placement='bottom' renders with the product-tooltip-bottom class", () => {
    vi.useFakeTimers();
    renderWithProviders(
      <ProductTooltip product={makeProductWithPrice()} placement="bottom">
        <span data-testid="trigger">Widget</span>
      </ProductTooltip>
    );
    fireEvent.mouseEnter(screen.getByTestId("trigger"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const tooltip = screen.getByRole("group", { name: /product preview/i });
    expect(tooltip.className).toContain("product-tooltip-bottom");
    expect(tooltip.className).not.toContain("product-tooltip-top");
  });

  it("portal renders the tooltip into document.body, not inside the trigger's parent", () => {
    vi.useFakeTimers();
    const { container } = renderWithProviders(
      <div data-testid="wrapper" style={{ overflow: "hidden" }}>
        <ProductTooltip product={makeProductWithPrice()}>
          <span data-testid="trigger">Widget</span>
        </ProductTooltip>
      </div>
    );
    fireEvent.mouseEnter(screen.getByTestId("trigger"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const tooltip = screen.getByRole("group", { name: /product preview/i });
    const wrapper = container.querySelector('[data-testid="wrapper"]');
    // The tooltip must NOT be inside the wrapper — proves it is portaled out
    expect(wrapper?.contains(tooltip)).toBe(false);
    expect(document.body.contains(tooltip)).toBe(true);
  });

  it("unmounting while the tooltip is open does not throw or leak listeners", () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderTooltip(makeProductWithPrice());
    fireEvent.mouseEnter(screen.getByTestId("trigger"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("group", { name: /product preview/i })).toBeInTheDocument();
    unmount();
    // After unmount, dispatching events on document must not blow up
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
