import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PriceInput from "../components/PriceInput";
import { renderWithProviders } from "./testUtils";

describe("PriceInput", () => {
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

  it("renders the form with label, text input, slider, and submit button", () => {
    renderWithProviders(
      <PriceInput category="Electronics" onSubmit={vi.fn()} disabled={false} />
    );
    expect(screen.getByText("Your Guess")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lock In Price" })).toBeInTheDocument();
  });

  it("disables inputs and button when disabled", () => {
    renderWithProviders(
      <PriceInput category="Electronics" onSubmit={vi.fn()} disabled={true} />
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("slider")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Lock In Price" })).toBeDisabled();
  });

  it("calls onSubmit with cents value when form is submitted", () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <PriceInput
        category="Electronics"
        priceRange={{ min: 100, max: 5000 }}
        onSubmit={onSubmit}
        disabled={false}
      />
    );

    // Set slider to a known value
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "2500" } });

    // Submit form
    fireEvent.click(screen.getByRole("button", { name: "Lock In Price" }));
    expect(onSubmit).toHaveBeenCalledWith(2500);
  });

  it("does not call onSubmit when disabled", () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <PriceInput category="Electronics" onSubmit={onSubmit} disabled={true} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Lock In Price" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onInteract when slider changes", () => {
    const onInteract = vi.fn();
    renderWithProviders(
      <PriceInput
        category="Electronics"
        onSubmit={vi.fn()}
        disabled={false}
        onInteract={onInteract}
      />
    );
    fireEvent.change(screen.getByRole("slider"), { target: { value: "1000" } });
    expect(onInteract).toHaveBeenCalled();
  });

  it("calls onInteract when text input changes", () => {
    const onInteract = vi.fn();
    renderWithProviders(
      <PriceInput
        category="Electronics"
        onSubmit={vi.fn()}
        disabled={false}
        onInteract={onInteract}
      />
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "$15.00" } });
    expect(onInteract).toHaveBeenCalled();
  });

  it("displays range labels from priceRange prop", () => {
    renderWithProviders(
      <PriceInput
        category="Electronics"
        priceRange={{ min: 500, max: 10000 }}
        onSubmit={vi.fn()}
        disabled={false}
      />
    );
    expect(screen.getByText("$5.00")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
  });

  it("uses default range when priceRange is not provided", () => {
    renderWithProviders(
      <PriceInput category="Electronics" onSubmit={vi.fn()} disabled={false} />
    );
    expect(screen.getByText("$1.00")).toBeInTheDocument();
    // Default max is 200000 cents = $2000.00
    expect(screen.getByText("$2000.00")).toBeInTheDocument();
  });

  it("clamps slider value on blur", () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <PriceInput
        category="Electronics"
        priceRange={{ min: 100, max: 5000 }}
        onSubmit={onSubmit}
        disabled={false}
      />
    );

    const textInput = screen.getByRole("textbox");
    fireEvent.change(textInput, { target: { value: "999" } });
    fireEvent.blur(textInput);

    // Submit to check clamped value
    fireEvent.click(screen.getByRole("button", { name: "Lock In Price" }));
    const calledCents = onSubmit.mock.calls[0][0];
    expect(calledCents).toBeGreaterThanOrEqual(100);
    expect(calledCents).toBeLessThanOrEqual(5000);
  });
});
