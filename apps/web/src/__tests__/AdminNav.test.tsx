/**
 * Tests for the AdminNav component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminNav from "../pages/admin/AdminNav";

const mockLogout = vi.fn();
const mockNavigate = vi.fn();

vi.mock("../../context/AdminAuthContext", () => ({
  useAdminAuth: () => ({
    user: { id: "1", username: "testadmin" },
    logout: mockLogout,
  }),
}));

// Resolve relative path — vitest resolves from __tests__ dir
vi.mock("../context/AdminAuthContext", () => ({
  useAdminAuth: () => ({
    user: { id: "1", username: "testadmin" },
    logout: mockLogout,
  }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("AdminNav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Analytics and Products links", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>
    );
    expect(screen.getByTestId("admin-nav-analytics")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-products")).toBeInTheDocument();
  });

  it("shows username", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>
    );
    expect(screen.getByTestId("admin-user-display")).toHaveTextContent("testadmin");
  });

  it("shows logout button", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>
    );
    expect(screen.getByTestId("admin-logout-btn")).toBeInTheDocument();
  });

  it("navigates to products on click", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByTestId("admin-nav-products"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/products");
  });

  it("navigates to analytics on click", () => {
    render(
      <MemoryRouter initialEntries={["/admin/products"]}>
        <AdminNav />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByTestId("admin-nav-analytics"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin");
  });

  it("highlights Analytics as active on /admin route", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>
    );
    expect(screen.getByTestId("admin-nav-analytics").className).toContain("active");
    expect(screen.getByTestId("admin-nav-products").className).not.toContain("active");
  });

  it("highlights Products as active on /admin/products route", () => {
    render(
      <MemoryRouter initialEntries={["/admin/products"]}>
        <AdminNav />
      </MemoryRouter>
    );
    expect(screen.getByTestId("admin-nav-products").className).toContain("active");
  });

  it("calls logout on button click", async () => {
    mockLogout.mockResolvedValueOnce(undefined);
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByTestId("admin-logout-btn"));
    expect(mockLogout).toHaveBeenCalled();
  });

  it("renders the UTM Tags nav link", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-nav-utm-tags")).toBeInTheDocument();
  });

  it("navigates to /admin/utm-tags when the UTM Tags link is clicked", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-utm-tags"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/utm-tags");
  });

  it("highlights UTM Tags as active on /admin/utm-tags route", () => {
    render(
      <MemoryRouter initialEntries={["/admin/utm-tags"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-nav-utm-tags").className).toContain("active");
    expect(screen.getByTestId("admin-nav-analytics").className).not.toContain("active");
  });

  it("keeps UTM Tags active on the detail sub-route", () => {
    render(
      <MemoryRouter initialEntries={["/admin/utm-tags/t-1"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-nav-utm-tags").className).toContain("active");
  });

  it("renders the Avatars nav link", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-nav-avatars")).toBeInTheDocument();
  });

  it("navigates to /admin/avatars when the Avatars link is clicked", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-avatars"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/avatars");
  });

  it("highlights Avatars as active on /admin/avatars route", () => {
    render(
      <MemoryRouter initialEntries={["/admin/avatars"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-nav-avatars").className).toContain("active");
    expect(screen.getByTestId("admin-nav-analytics").className).not.toContain("active");
  });

  it("renders group labels for tab categories", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    // The desktop tree and the drawer both list group labels (drawer is
    // hidden via CSS at large viewports). Use getAllByText so the matcher
    // tolerates both copies — what matters is that each group is reachable
    // somewhere in the markup.
    expect(screen.getAllByText("Data").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Marketing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Game").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Content").length).toBeGreaterThan(0);
  });

  // ── Mobile drawer ────────────────────────────────────────────────
  // The drawer markup is always rendered (so CSS transitions work) but
  // the parent display swap is what hides/shows it based on viewport.
  // We assert presence + open/close behavior at the markup level — visual
  // hiding is covered by CSS, not JS.

  it("renders the mobile hamburger button", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    const hamburger = screen.getByTestId("admin-nav-hamburger");
    expect(hamburger).toBeInTheDocument();
    expect(hamburger).toHaveAttribute("aria-expanded", "false");
    expect(hamburger).toHaveAttribute("aria-controls", "admin-nav-drawer");
  });

  it("renders the drawer in closed state by default", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    const drawer = screen.getByTestId("admin-nav-drawer");
    expect(drawer).toBeInTheDocument();
    expect(drawer).toHaveAttribute("aria-hidden", "true");
    expect(drawer.className).not.toContain("open");
    // Scrim is only rendered when drawer is open.
    expect(screen.queryByTestId("admin-nav-drawer-scrim")).not.toBeInTheDocument();
  });

  it("opens the drawer when the hamburger is clicked", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    const drawer = screen.getByTestId("admin-nav-drawer");
    expect(drawer.className).toContain("open");
    expect(drawer).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByTestId("admin-nav-hamburger")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("admin-nav-drawer-scrim")).toBeInTheDocument();
  });

  it("closes the drawer when the scrim is clicked", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    expect(screen.getByTestId("admin-nav-drawer").className).toContain("open");
    fireEvent.click(screen.getByTestId("admin-nav-drawer-scrim"));
    expect(screen.getByTestId("admin-nav-drawer").className).not.toContain("open");
  });

  it("closes the drawer when its close button is clicked", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    expect(screen.getByTestId("admin-nav-drawer").className).toContain("open");
    fireEvent.click(screen.getByTestId("admin-nav-drawer-close"));
    expect(screen.getByTestId("admin-nav-drawer").className).not.toContain("open");
  });

  it("renders the same nav items inside the drawer as the desktop tab tree", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    // Spot-check a few critical items across all groups
    expect(screen.getByTestId("admin-nav-drawer-analytics")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-drawer-products")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-drawer-users")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-drawer-rewards")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-drawer-utm-tags")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-drawer-game-modes")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-drawer-gallery")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-drawer-security")).toBeInTheDocument();
    expect(screen.getByTestId("admin-nav-drawer-logout")).toBeInTheDocument();
  });

  it("navigates from a drawer link click", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    fireEvent.click(screen.getByTestId("admin-nav-drawer-products"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/products");
  });

  it("calls logout from the drawer logout link", async () => {
    mockLogout.mockResolvedValueOnce(undefined);
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    fireEvent.click(screen.getByTestId("admin-nav-drawer-logout"));
    expect(mockLogout).toHaveBeenCalled();
  });

  it("displays the active tab label in the mobile header", () => {
    render(
      <MemoryRouter initialEntries={["/admin/products"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-nav-mobile-title").textContent).toBe("Products");
  });

  it("highlights the active tab inside the drawer", () => {
    render(
      <MemoryRouter initialEntries={["/admin/users"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    expect(screen.getByTestId("admin-nav-drawer-users").className).toContain("active");
    expect(screen.getByTestId("admin-nav-drawer-products").className).not.toContain("active");
  });

  it("closes the drawer on Escape key", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    expect(screen.getByTestId("admin-nav-drawer").className).toContain("open");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("admin-nav-drawer").className).not.toContain("open");
  });

  it("removes drawer buttons from the tab order while closed (a11y)", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    // While closed, every focusable drawer control is tabIndex=-1 so
    // keyboard users do not land on invisible controls. The drawer is
    // still in the DOM (CSS handles slide animation).
    expect(screen.getByTestId("admin-nav-drawer-close")).toHaveAttribute("tabIndex", "-1");
    expect(screen.getByTestId("admin-nav-drawer-products")).toHaveAttribute("tabIndex", "-1");
    expect(screen.getByTestId("admin-nav-drawer-logout")).toHaveAttribute("tabIndex", "-1");
  });

  it("includes drawer buttons in the tab order while open (a11y)", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    expect(screen.getByTestId("admin-nav-drawer-close")).toHaveAttribute("tabIndex", "0");
    expect(screen.getByTestId("admin-nav-drawer-products")).toHaveAttribute("tabIndex", "0");
    expect(screen.getByTestId("admin-nav-drawer-logout")).toHaveAttribute("tabIndex", "0");
  });

  it("moves focus into the drawer when it opens", () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminNav />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-nav-hamburger"));
    // Focus management lands on the close button — chosen because it's
    // the first focusable control inside the dialog and a clear escape
    // hatch for the user.
    expect(document.activeElement).toBe(screen.getByTestId("admin-nav-drawer-close"));
  });
});
