import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import ProductCard from "../components/ProductCard";
import { makeProduct, renderWithProviders } from "./testUtils";

describe("ProductCard", () => {
  it("renders the product title", () => {
    renderWithProviders(<ProductCard product={makeProduct({ title: "Cool Gadget" })} />);
    expect(screen.getByText("Cool Gadget")).toBeInTheDocument();
  });

  it("renders the product category badge", () => {
    renderWithProviders(<ProductCard product={makeProduct({ category: "Toys & Games" })} />);
    expect(screen.getByText("Toys & Games")).toBeInTheDocument();
  });

  it("renders the product image with correct alt text", () => {
    renderWithProviders(<ProductCard product={makeProduct({ title: "My Widget" })} />);
    const img = screen.getByAltText("My Widget");
    expect(img).toBeInTheDocument();
  });

  it("opens image modal on image wrapper click", () => {
    renderWithProviders(<ProductCard product={makeProduct()} />);
    const wrapper = document.querySelector(".product-image-wrapper");
    fireEvent.click(wrapper!);
    // ImageModal renders with role="dialog"
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes image modal when close button is clicked", () => {
    renderWithProviders(<ProductCard product={makeProduct()} />);
    fireEvent.click(document.querySelector(".product-image-wrapper")!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("replaces broken images with fallback SVG", () => {
    renderWithProviders(<ProductCard product={makeProduct({ imageUrl: "https://broken.url/img.jpg" })} />);
    const img = screen.getByAltText("Test Widget") as HTMLImageElement;
    fireEvent.error(img);
    expect(img.src).toContain("data:image/svg+xml");
  });

  // iOS Safari: without decoding="async" the image decode runs on the main
  // thread during paint, which can stall round transitions.
  it('sets decoding="async" on the product image', () => {
    renderWithProviders(<ProductCard product={makeProduct()} />);
    const img = screen.getByAltText("Test Widget") as HTMLImageElement;
    expect(img.getAttribute("decoding")).toBe("async");
  });

  // iOS Safari: re-keying per product forces a fresh HTMLImageElement rather
  // than mutating src on an in-flight load. Without this, WebKit can swallow
  // the error event on cancellation and leave the element blank until a page
  // refresh — the bug this file's key changes exist to prevent.
  it("remounts the image element when product.id changes", () => {
    const { rerender } = renderWithProviders(
      <ProductCard key={1} product={makeProduct({ id: 1, title: "First" })} />
    );
    const firstImg = screen.getByAltText("First");

    rerender(<ProductCard key={2} product={makeProduct({ id: 2, title: "Second" })} />);
    const secondImg = screen.getByAltText("Second");

    // Different DOM nodes → a true remount, not just an `src` swap.
    expect(secondImg).not.toBe(firstImg);
  });
});
