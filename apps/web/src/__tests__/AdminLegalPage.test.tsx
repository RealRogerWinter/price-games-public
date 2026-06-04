/**
 * Tests for the AdminLegalPage component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

vi.mock("../api/adminClient", () => ({
  getLegalDocument: vi.fn(),
  updateLegalDocument: vi.fn(),
}));

vi.mock("marked", () => ({
  Marked: class MockMarked {
    parse(md: string) {
      return `<p>${md}</p>`;
    }
  },
}));

vi.mock("dompurify", () => ({
  default: { sanitize: (html: string) => html },
}));

import * as adminClient from "../api/adminClient";
import AdminLegalPage from "../pages/admin/AdminLegalPage";

const mockGetLegalDocument = vi.mocked(adminClient.getLegalDocument);
const mockUpdateLegalDocument = vi.mocked(adminClient.updateLegalDocument);

const privacyContent = "# Privacy Policy\n\nThis is the privacy policy.";
const termsContent = "# Terms of Service\n\nThese are the terms.";

function setupDefaultMocks() {
  mockGetLegalDocument.mockImplementation((key: string) =>
    Promise.resolve({ key, content: key === "privacy_policy" ? privacyContent : termsContent })
  );
  mockUpdateLegalDocument.mockResolvedValue({ key: "privacy_policy", ok: true });
}

describe("AdminLegalPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("shows loading state while fetching documents", () => {
    mockGetLegalDocument.mockReturnValue(new Promise(() => {}));
    render(<AdminLegalPage />);
    expect(screen.getByText(/loading legal documents/i)).toBeInTheDocument();
  });

  it("renders the editor after documents load", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("admin-legal-page")).toBeInTheDocument();
    });
    expect(screen.getByTestId("legal-textarea")).toBeInTheDocument();
    expect(screen.getByTestId("legal-save-btn")).toBeInTheDocument();
    expect(screen.getByTestId("legal-save-all-btn")).toBeInTheDocument();
  });

  it("shows both document tabs", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-tab-privacy_policy")).toBeInTheDocument();
    });
    expect(screen.getByTestId("legal-tab-terms_of_service")).toBeInTheDocument();
  });

  it("loads getLegalDocument for both documents on mount", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(mockGetLegalDocument).toHaveBeenCalledWith("privacy_policy");
    });
    expect(mockGetLegalDocument).toHaveBeenCalledWith("terms_of_service");
  });

  it("textarea shows content for active doc (privacy_policy by default)", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-textarea")).toBeInTheDocument();
    });
    const textarea = screen.getByTestId("legal-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe(privacyContent);
  });

  it("tab switching changes active document content", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-tab-terms_of_service")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("legal-tab-terms_of_service"));

    const textarea = screen.getByTestId("legal-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe(termsContent);
  });

  it("editing textarea updates content", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-textarea")).toBeInTheDocument();
    });

    const textarea = screen.getByTestId("legal-textarea");
    fireEvent.change(textarea, { target: { value: "Updated privacy content" } });

    expect((textarea as HTMLTextAreaElement).value).toBe("Updated privacy content");
  });

  it("Save button calls updateLegalDocument with active doc", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-save-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-save-btn"));
    });

    await waitFor(() => {
      expect(mockUpdateLegalDocument).toHaveBeenCalledWith("privacy_policy", privacyContent);
    });
  });

  it("Save button on terms_of_service tab saves terms content", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-tab-terms_of_service")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("legal-tab-terms_of_service"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-save-btn"));
    });

    await waitFor(() => {
      expect(mockUpdateLegalDocument).toHaveBeenCalledWith("terms_of_service", termsContent);
    });
  });

  it("Save All button calls updateLegalDocument for both documents", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-save-all-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-save-all-btn"));
    });

    await waitFor(() => {
      expect(mockUpdateLegalDocument).toHaveBeenCalledWith("privacy_policy", privacyContent);
      expect(mockUpdateLegalDocument).toHaveBeenCalledWith("terms_of_service", termsContent);
    });
  });

  it("shows success message after save", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-save-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-save-btn"));
    });

    await waitFor(() => {
      expect(screen.getByText("Privacy Policy saved")).toBeInTheDocument();
    });
  });

  it("shows success message 'All documents saved' after Save All", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-save-all-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-save-all-btn"));
    });

    await waitFor(() => {
      expect(screen.getByText("All documents saved")).toBeInTheDocument();
    });
  });

  it("shows error message when save fails", async () => {
    mockUpdateLegalDocument.mockRejectedValueOnce(new Error("Save failed"));
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-save-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-save-btn"));
    });

    await waitFor(() => {
      expect(screen.getByText("Save failed")).toBeInTheDocument();
    });
  });

  it("shows error message when Save All fails", async () => {
    mockUpdateLegalDocument.mockRejectedValueOnce(new Error("Network error"));
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-save-all-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("legal-save-all-btn"));
    });

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("shows loading error state when getLegalDocument fails", async () => {
    mockGetLegalDocument.mockRejectedValue(new Error("Network failure"));
    render(<AdminLegalPage />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load legal documents")).toBeInTheDocument();
    });
  });

  it("preview toggle shows preview pane when enabled", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-textarea")).toBeInTheDocument();
    });

    expect(screen.queryByText("Preview")).not.toBeInTheDocument();

    const previewCheckbox = screen.getByRole("checkbox");
    fireEvent.click(previewCheckbox);

    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("preview pane is hidden when preview toggle is off", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-textarea")).toBeInTheDocument();
    });

    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
  });

  it("preview pane shows rendered HTML content", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-textarea")).toBeInTheDocument();
    });

    const previewCheckbox = screen.getByRole("checkbox");
    fireEvent.click(previewCheckbox);

    // The mock returns <p>{md}</p> for the content
    const previewPane = document.querySelector(".admin-legal-preview-pane");
    expect(previewPane).toBeInTheDocument();
    expect(previewPane?.querySelector(".legal-body")).toBeInTheDocument();
  });

  it("save button shows 'Saving...' while saving", async () => {
    mockUpdateLegalDocument.mockReturnValue(new Promise(() => {}));
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-save-btn")).toBeInTheDocument();
    });

    const saveBtn = screen.getByTestId("legal-save-btn");
    fireEvent.click(saveBtn);

    expect(saveBtn).toBeDisabled();
    expect(saveBtn.textContent).toContain("Saving...");
  });

  it("privacy_policy tab is active by default", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-tab-privacy_policy")).toBeInTheDocument();
    });
    expect(screen.getByTestId("legal-tab-privacy_policy")).toHaveClass("active");
    expect(screen.getByTestId("legal-tab-terms_of_service")).not.toHaveClass("active");
  });

  it("clicking terms tab makes it active", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-tab-terms_of_service")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("legal-tab-terms_of_service"));

    expect(screen.getByTestId("legal-tab-terms_of_service")).toHaveClass("active");
    expect(screen.getByTestId("legal-tab-privacy_policy")).not.toHaveClass("active");
  });

  it("save button label reflects active document", async () => {
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-save-btn")).toBeInTheDocument();
    });

    expect(screen.getByTestId("legal-save-btn")).toHaveTextContent("Save Privacy Policy");

    fireEvent.click(screen.getByTestId("legal-tab-terms_of_service"));

    expect(screen.getByTestId("legal-save-btn")).toHaveTextContent("Save Terms of Service");
  });

  it("shows 'No content to preview' when textarea is empty", async () => {
    mockGetLegalDocument.mockImplementation((key: string) =>
      Promise.resolve({ key, content: "" })
    );
    render(<AdminLegalPage />);
    await waitFor(() => {
      expect(screen.getByTestId("legal-textarea")).toBeInTheDocument();
    });

    const previewCheckbox = screen.getByRole("checkbox");
    fireEvent.click(previewCheckbox);

    expect(screen.getByText("No content to preview")).toBeInTheDocument();
  });
});
