import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, waitFor, fireEvent } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";

// Mock react-router-dom before any import that uses it. SEO.tsx reads
// location.pathname, so include a sensible default in the stub.
const mockNavigate = vi.fn();
let mockLocationKey = "test-key";
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ key: mockLocationKey, pathname: "/privacy" }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

/** Render helper that wraps every test tree in HelmetProvider — SEO.tsx
 *  uses react-helmet-async and needs the provider at the root. */
function render(ui: React.ReactElement) {
  return rtlRender(<HelmetProvider>{ui}</HelmetProvider>);
}

// Mock DOMPurify to avoid JSDOM limitations; it just returns the input string
vi.mock("dompurify", () => ({
  default: {
    sanitize: (html: string) => html,
  },
}));

vi.mock("../components/auth/UserDropdown", () => ({
  default: () => <div data-testid="user-dropdown">UserDropdown</div>,
}));

import React from "react";
import LegalPage from "../pages/LegalPage";

describe("LegalPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocationKey = "test-key";
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /** Mock a successful fetch returning the given markdown content. */
  function mockFetchContent(content: string) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: "privacy_policy", content }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  /** Mock a fetch that returns an empty/null content document. */
  function mockFetchEmpty() {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: "privacy_policy", content: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  /** Mock a non-ok (404/500) fetch response. */
  function mockFetchError(status = 404) {
    fetchSpy.mockResolvedValueOnce(
      new Response("Not found", { status })
    );
  }

  // ===== Loading state =====

  it("shows Loading... while fetch is in progress", () => {
    fetchSpy.mockReturnValueOnce(new Promise(() => {}));
    render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" />
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  // ===== Page mode =====

  it("renders page mode with title and content after load", async () => {
    mockFetchContent("# My Document Heading\n\nYour data is safe with us.");
    render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    // The page title (h1 with class legal-page-title) should appear
    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    // Rendered markdown heading should also appear
    expect(screen.getByText("My Document Heading")).toBeInTheDocument();
    // Markdown body content should appear
    expect(screen.getByText("Your data is safe with us.")).toBeInTheDocument();
  });

  it("fetches the document from the correct URL", async () => {
    mockFetchContent("# Terms");
    render(
      <LegalPage docKey="terms_of_service" title="Terms of Service" />
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/settings/legal/terms_of_service");
    });
  });

  it("shows empty state when server returns no content", async () => {
    mockFetchEmpty();
    render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" />
    );

    await waitFor(() => {
      expect(screen.getByText("This document has not been configured yet.")).toBeInTheDocument();
    });
  });

  it("shows empty state when fetch returns a non-ok response", async () => {
    mockFetchError(404);
    render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    expect(screen.getByText("This document has not been configured yet.")).toBeInTheDocument();
  });

  it("renders Back button in page mode", async () => {
    mockFetchContent("Some content");
    render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    // Back button is rendered via innerHTML arrow character ← plus " Back"
    const backBtn = screen.getByRole("button", { name: /back/i });
    expect(backBtn).toBeInTheDocument();
  });

  it("calls navigate(-1) when Back button clicked and location key is not 'default'", async () => {
    // useLocation returns { key: "test-key" } (not "default"), so navigate(-1) is called
    mockFetchContent("Some content");
    render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it("renders the affiliate disclosure footer in page mode", async () => {
    // Footer *link* visibility is now driven by the admin page-visibility
    // toggle (see SiteFooter.test.tsx). Here we just assert the footer
    // element itself is rendered so LegalPage still includes it.
    mockFetchContent("Content");
    const { container } = render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    expect(container.querySelector(".affiliate-disclosure")).toBeInTheDocument();
  });

  it("does not render a modal overlay in page mode", async () => {
    mockFetchContent("Content");
    const { container } = render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    expect(container.querySelector(".legal-modal-overlay")).not.toBeInTheDocument();
  });

  // ===== Modal mode =====

  it("renders modal overlay when isModal=true", async () => {
    mockFetchContent("Modal content");
    const { container } = render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" isModal />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    expect(container.querySelector(".legal-modal-overlay")).toBeInTheDocument();
    expect(container.querySelector(".legal-modal-content")).toBeInTheDocument();
  });

  it("renders close button in modal mode", async () => {
    mockFetchContent("Modal content");
    const { container } = render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" isModal onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    const closeBtn = container.querySelector(".legal-modal-close");
    expect(closeBtn).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked in modal mode", async () => {
    const onClose = vi.fn();
    mockFetchContent("Modal content");
    const { container } = render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" isModal onClose={onClose} />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    const closeBtn = container.querySelector(".legal-modal-close") as HTMLElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when modal overlay background is clicked", async () => {
    const onClose = vi.fn();
    mockFetchContent("Modal content");
    const { container } = render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" isModal onClose={onClose} />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    const overlay = container.querySelector(".legal-modal-overlay") as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows modal title in modal mode", async () => {
    mockFetchContent("Modal content");
    render(
      <LegalPage docKey="terms_of_service" title="Terms of Service" isModal />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("Terms of Service");
  });

  it("shows Loading... inside modal while fetching", () => {
    fetchSpy.mockReturnValueOnce(new Promise(() => {}));
    render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" isModal onClose={vi.fn()} />
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows empty state inside modal when content is empty", async () => {
    mockFetchEmpty();
    render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" isModal onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("This document has not been configured yet.")).toBeInTheDocument();
    });
  });

  it("does not render footer in modal mode", async () => {
    mockFetchContent("Modal content");
    const { container } = render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" isModal onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    expect(container.querySelector(".affiliate-disclosure")).not.toBeInTheDocument();
  });

  // ===== handleClose fallback when no onClose and key is 'default' =====

  it("navigates to '/' when Back is clicked and location key is 'default'", async () => {
    // Set location key to "default" so navigate("/") is called instead of navigate(-1)
    mockLocationKey = "default";

    mockFetchContent("Content");
    render(
      <LegalPage docKey="privacy_policy" title="Privacy Policy" />
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });
});
