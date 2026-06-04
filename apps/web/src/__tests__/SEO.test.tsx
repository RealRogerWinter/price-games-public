import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import SEO from "../components/SEO";

/**
 * Wait for react-helmet-async to flush its side effects into document.head.
 * Two RAFs covers the case where a nested state update happens between
 * the Helmet render and the flush.
 */
async function flushHelmet() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

function renderWithRouter(path: string, element: React.ReactElement) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>
    </HelmetProvider>,
  );
}

afterEach(() => {
  cleanup();
  // Clean up the title + meta tags between tests (jsdom shares document.head).
  document.head.querySelectorAll('meta[name="description"],meta[name="robots"],link[rel="canonical"]').forEach((n) => n.remove());
});

describe("<SEO>", () => {
  it("renders the resolved title + description for the /about route when no props", async () => {
    renderWithRouter("/about", <SEO />);
    await flushHelmet();
    expect(document.title).toBe("About Price Games");
    const desc = document.head.querySelector('meta[name="description"]');
    expect(desc?.getAttribute("content")).toMatch(/About Price Games|price-guessing/i);
  });

  it("overrides title and description when props are supplied", async () => {
    renderWithRouter("/", <SEO title="Custom Title" description="Custom desc" />);
    await flushHelmet();
    expect(document.title).toBe("Custom Title");
    const desc = document.head.querySelector('meta[name="description"]');
    expect(desc?.getAttribute("content")).toBe("Custom desc");
  });

  it("sets a canonical link pointing at the current path by default", async () => {
    renderWithRouter("/faq", <SEO />);
    await flushHelmet();
    const canonical = document.head.querySelector('link[rel="canonical"]');
    expect(canonical?.getAttribute("href")).toBe("https://price.games/faq");
  });

  it("emits a noindex meta tag for noindex routes like /settings", async () => {
    renderWithRouter("/settings", <SEO />);
    await flushHelmet();
    const robots = document.head.querySelector('meta[name="robots"]');
    expect(robots?.getAttribute("content")).toBe("noindex,nofollow");
  });

  it("does NOT emit a robots tag for indexable routes", async () => {
    renderWithRouter("/about", <SEO />);
    await flushHelmet();
    const robots = document.head.querySelector('meta[name="robots"]');
    expect(robots).toBeNull();
  });

  it("emits the provided JSON-LD structured data", async () => {
    const ld = { "@context": "https://schema.org", "@type": "WebSite", name: "Test" };
    renderWithRouter("/", <SEO jsonLd={ld} />);
    await flushHelmet();
    const scripts = Array.from(
      document.head.querySelectorAll('script[type="application/ld+json"]'),
    );
    const match = scripts.find((s) => s.textContent?.includes('"@type":"WebSite"'));
    expect(match).toBeDefined();
  });
});
