import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ImageModal from "../components/ImageModal";

describe("ImageModal", () => {
  it("renders with role dialog and aria-modal", () => {
    render(<ImageModal src="https://example.com/img.jpg" alt="Test" onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Image preview");
  });

  it("renders the image with correct src and alt", () => {
    render(<ImageModal src="https://example.com/photo.jpg" alt="A photo" onClose={vi.fn()} />);
    const img = screen.getByAltText("A photo");
    expect(img).toHaveAttribute("src", "https://example.com/photo.jpg");
  });

  it("calls onClose when overlay is clicked", () => {
    const onClose = vi.fn();
    render(<ImageModal src="test.jpg" alt="Test" onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when image is clicked (stopPropagation)", () => {
    const onClose = vi.fn();
    render(<ImageModal src="test.jpg" alt="Test" onClose={onClose} />);
    fireEvent.click(screen.getByAltText("Test"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(<ImageModal src="test.jpg" alt="Test" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders close button with aria-label", () => {
    render(<ImageModal src="test.jpg" alt="Test" onClose={vi.fn()} />);
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
  });

  it("calls onClose exactly once when close button is clicked", () => {
    const onClose = vi.fn();
    render(<ImageModal src="test.jpg" alt="Test" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
