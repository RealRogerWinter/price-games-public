/**
 * Tests for the ManufacturerModal component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ManufacturerModal from "../pages/admin/ManufacturerModal";

const mockManufacturer = {
  manufacturer: {
    id: 1,
    name: "Sony",
    website: "https://sony.com",
    productCount: 25,
    searchStatus: "searched",
  },
  contacts: [
    {
      id: 10,
      manufacturerId: 1,
      contactType: "media",
      email: "press@sony.com",
      phone: "555-1234",
      contactPageUrl: "https://sony.com/contact",
      sourceUrl: "https://sony.com",
      confidence: "high",
      notes: "Main PR contact",
      verifiedAt: null,
    },
    {
      id: 11,
      manufacturerId: 1,
      contactType: "support",
      email: "support@sony.com",
      phone: null,
      contactPageUrl: null,
      sourceUrl: null,
      confidence: "low",
      notes: null,
      verifiedAt: null,
    },
  ],
};

const mockGetManufacturerContacts = vi.fn().mockResolvedValue(mockManufacturer);
const mockAddManufacturerContact = vi.fn().mockResolvedValue({
  id: 12, manufacturerId: 1, contactType: "general", email: "new@sony.com",
  phone: null, contactPageUrl: null, sourceUrl: null, confidence: "medium",
  notes: null, verifiedAt: null,
});
const mockUpdateManufacturerContact = vi.fn().mockResolvedValue({
  ...mockManufacturer.contacts[0],
  email: "updated@sony.com",
});
const mockDeleteManufacturerContact = vi.fn().mockResolvedValue({ ok: true });

vi.mock("../api/adminClient", () => ({
  getManufacturerContacts: (...args: unknown[]) => mockGetManufacturerContacts(...args),
  addManufacturerContact: (...args: unknown[]) => mockAddManufacturerContact(...args),
  updateManufacturerContact: (...args: unknown[]) => mockUpdateManufacturerContact(...args),
  deleteManufacturerContact: (...args: unknown[]) => mockDeleteManufacturerContact(...args),
}));

// Also mock the path that ManufacturerModal uses (relative from pages/admin/)
vi.mock("../../api/adminClient", () => ({
  getManufacturerContacts: (...args: unknown[]) => mockGetManufacturerContacts(...args),
  addManufacturerContact: (...args: unknown[]) => mockAddManufacturerContact(...args),
  updateManufacturerContact: (...args: unknown[]) => mockUpdateManufacturerContact(...args),
  deleteManufacturerContact: (...args: unknown[]) => mockDeleteManufacturerContact(...args),
}));

describe("ManufacturerModal", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders modal with manufacturer info", async () => {
    render(<ManufacturerModal name="Sony" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("manufacturer-info")).toBeInTheDocument();
    });
    expect(screen.getByText("Sony")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
  });

  it("shows website link", async () => {
    render(<ManufacturerModal name="Sony" onClose={onClose} />);
    await waitFor(() => {
      const link = screen.getByText("https://sony.com");
      expect(link).toBeInTheDocument();
      expect(link.tagName).toBe("A");
    });
  });

  it("shows contacts table", async () => {
    render(<ManufacturerModal name="Sony" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("contacts-table")).toBeInTheDocument();
    });
    expect(screen.getByText("press@sony.com")).toBeInTheDocument();
    expect(screen.getByText("support@sony.com")).toBeInTheDocument();
  });

  it("shows confidence badges", async () => {
    render(<ManufacturerModal name="Sony" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("contacts-table")).toBeInTheDocument();
    });
    const badges = screen.getAllByText(/high|low/);
    expect(badges.length).toBeGreaterThanOrEqual(2);
  });

  it("closes on X button click", async () => {
    render(<ManufacturerModal name="Sony" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("modal-close")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("modal-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on overlay click", async () => {
    render(<ManufacturerModal name="Sony" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("manufacturer-modal")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("manufacturer-modal"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows not found state", async () => {
    mockGetManufacturerContacts.mockRejectedValueOnce(new Error("404 Not found"));
    render(<ManufacturerModal name="Unknown" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("manufacturer-not-found")).toBeInTheDocument();
    });
  });

  it("shows add contact form", async () => {
    render(<ManufacturerModal name="Sony" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("show-add-contact")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("show-add-contact"));
    expect(screen.getByTestId("add-contact-form")).toBeInTheDocument();
  });

  it("enters edit mode on contact click", async () => {
    render(<ManufacturerModal name="Sony" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("edit-contact-10")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("edit-contact-10"));
    expect(screen.getByTestId("save-edit-btn")).toBeInTheDocument();
  });

  it("shows delete confirmation", async () => {
    render(<ManufacturerModal name="Sony" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("delete-contact-10")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("delete-contact-10"));
    expect(screen.getByTestId("confirm-delete-10")).toBeInTheDocument();
  });

  it("shows no contacts message when contacts array is empty", async () => {
    mockGetManufacturerContacts.mockResolvedValueOnce({
      manufacturer: { id: 2, name: "NewBrand", website: null, productCount: 1, searchStatus: "pending" },
      contacts: [],
    });
    render(<ManufacturerModal name="NewBrand" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByTestId("no-contacts")).toBeInTheDocument();
    });
  });
});
