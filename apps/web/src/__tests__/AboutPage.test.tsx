import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ key: "test-key", pathname: "/about" }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

// DOMPurify is a no-op in JSDOM-limited environments; return the input HTML.
vi.mock("dompurify", () => ({
  default: { sanitize: (html: string) => html },
}));

vi.mock("../components/auth/UserDropdown", () => ({
  default: () => <div data-testid="user-dropdown">UserDropdown</div>,
}));

function render(ui: React.ReactElement) {
  return rtlRender(<HelmetProvider>{ui}</HelmetProvider>);
}

import React from "react";
import AboutPage, { parseAbout } from "../pages/AboutPage";

describe("parseAbout", () => {
  it("extracts the h1 title, lead, and top-level sections", () => {
    const md = [
      "# About Us",
      "",
      "Lead paragraph one.",
      "",
      "Lead paragraph two.",
      "",
      "## First Section",
      "Body of first.",
      "",
      "## Second Section",
      "Body of second.",
    ].join("\n");

    const out = parseAbout(md);
    expect(out.title).toBe("About Us");
    expect(out.lead).toContain("Lead paragraph one.");
    expect(out.lead).toContain("Lead paragraph two.");
    expect(out.sections).toHaveLength(2);
    expect(out.sections[0].heading).toBe("First Section");
    expect(out.sections[0].body.trim()).toBe("Body of first.");
    expect(out.sections[1].heading).toBe("Second Section");
  });

  it("treats `## ` inside fenced code blocks as literal content, not section headers", () => {
    const md = [
      "# Title",
      "",
      "Intro.",
      "",
      "## Real Section",
      "Before fence.",
      "```",
      "## NOT a heading inside fence",
      "```",
      "After fence.",
    ].join("\n");

    const out = parseAbout(md);
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0].heading).toBe("Real Section");
    expect(out.sections[0].body).toContain("## NOT a heading inside fence");
    expect(out.sections[0].body).toContain("After fence.");
  });

  it("handles markdown with no h1 title by returning title=null and treating everything as lead or sections", () => {
    const md = "No heading here.\n\n## Only Section\nBody.";
    const out = parseAbout(md);
    expect(out.title).toBeNull();
    expect(out.lead).toBe("No heading here.");
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0].heading).toBe("Only Section");
  });

  it("returns empty sections array when there are no ## headings", () => {
    const md = "# Title\n\nJust a lead paragraph, no sections.";
    const out = parseAbout(md);
    expect(out.title).toBe("Title");
    expect(out.lead).toBe("Just a lead paragraph, no sections.");
    expect(out.sections).toHaveLength(0);
  });

  it("handles empty string input without throwing", () => {
    const out = parseAbout("");
    expect(out.title).toBeNull();
    expect(out.lead).toBe("");
    expect(out.sections).toHaveLength(0);
  });

  it("supports tilde-fenced code blocks in addition to backticks", () => {
    const md = [
      "## Real",
      "~~~",
      "## fake inside tilde",
      "~~~",
      "## Real Two",
    ].join("\n");
    const out = parseAbout(md);
    expect(out.sections.map((s) => s.heading)).toEqual(["Real", "Real Two"]);
  });
});

describe("AboutPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetchAbout(body: string, title = "About Price Games") {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: "about", title, body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  it("shows Loading... while the fetch is in-flight", () => {
    fetchSpy.mockReturnValueOnce(new Promise(() => {}));
    render(<AboutPage />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders the sectioned layout when markdown has ## sections", async () => {
    mockFetchAbout(
      "# About\n\nLead.\n\n## What Is price.games?\nFirst body.\n\n## Who We Are\nSecond body.",
    );
    const { container } = render(<AboutPage />);

    await waitFor(() =>
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument(),
    );

    expect(container.querySelectorAll(".about-section")).toHaveLength(2);
    expect(container.querySelector(".about-hero")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "What Is price.games?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Who We Are" }),
    ).toBeInTheDocument();
  });

  it("falls back to the single-card legal-body render when markdown has no ## sections", async () => {
    mockFetchAbout("# About\n\nJust a paragraph, no sections at all.");
    const { container } = render(<AboutPage />);

    await waitFor(() =>
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument(),
    );

    expect(container.querySelector(".about-hero")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".about-section")).toHaveLength(0);
    expect(container.querySelector(".legal-body")).toBeInTheDocument();
    expect(screen.getByText(/Just a paragraph/)).toBeInTheDocument();
  });

  it("shows the empty state when the content body is empty", async () => {
    mockFetchAbout("");
    render(<AboutPage />);

    await waitFor(() =>
      expect(
        screen.getByText("This page has not been configured yet."),
      ).toBeInTheDocument(),
    );
  });

  it("shows the empty state when the fetch fails", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    render(<AboutPage />);

    await waitFor(() =>
      expect(
        screen.getByText("This page has not been configured yet."),
      ).toBeInTheDocument(),
    );
  });
});
