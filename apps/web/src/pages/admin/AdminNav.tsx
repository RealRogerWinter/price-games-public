import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../../context/AdminAuthContext";

interface NavTab {
  key: string;
  label: string;
  path: string;
  /** When true, only match exact path (for Analytics at /admin). */
  exact?: boolean;
}

interface NavGroup {
  label: string;
  tabs: NavTab[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Data",
    tabs: [
      { key: "analytics", label: "Dashboard", path: "/admin", exact: true },
      { key: "analytics-v2", label: "Insights", path: "/admin/analytics" },
      { key: "products", label: "Products", path: "/admin/products" },
      { key: "users", label: "Users", path: "/admin/users" },
      { key: "leaderboard", label: "Leaderboard", path: "/admin/leaderboard" },
    ],
  },
  {
    label: "Marketing",
    tabs: [
      { key: "rewards", label: "Rewards", path: "/admin/rewards" },
      { key: "referrals", label: "Referrals", path: "/admin/referrals" },
      { key: "utm-tags", label: "UTM Tags", path: "/admin/utm-tags" },
      { key: "banner", label: "Banner", path: "/admin/banner" },
      { key: "notifications", label: "Notifications", path: "/admin/notifications" },
      { key: "email", label: "Emails", path: "/admin/email" },
    ],
  },
  {
    label: "Game",
    tabs: [
      { key: "game-modes", label: "Game Modes", path: "/admin/game-modes" },
      { key: "daily-mode", label: "Daily Mode", path: "/admin/daily-mode" },
      { key: "avatars", label: "Avatars", path: "/admin/avatars" },
      { key: "ghost-users", label: "Ghost Users", path: "/admin/ghost-users" },
    ],
  },
  {
    label: "Content",
    tabs: [
      { key: "gallery", label: "Gallery", path: "/admin/gallery" },
      { key: "extension", label: "Extension", path: "/admin/extension" },
      { key: "content", label: "Pages", path: "/admin/content" },
      { key: "legal", label: "Legal", path: "/admin/legal" },
      { key: "pages", label: "Visibility", path: "/admin/pages" },
    ],
  },
];

/**
 * Determine which tab is active based on the current URL path.
 * Uses longest-prefix matching so /admin/products/123 matches "products"
 * and /admin matches "analytics" (exact-only).
 */
function getActiveTab(pathname: string): string {
  let best: { key: string; len: number } | null = null;
  for (const group of NAV_GROUPS) {
    for (const tab of group.tabs) {
      if (tab.exact) {
        if (pathname === tab.path) return tab.key;
        continue;
      }
      if (pathname.startsWith(tab.path) && (!best || tab.path.length > best.len)) {
        best = { key: tab.key, len: tab.path.length };
      }
    }
  }
  if (pathname.startsWith("/admin/security")) return "security";
  return best?.key ?? "analytics";
}

/** Find the human label of the active tab for the mobile header. */
function getActiveLabel(activeKey: string): string {
  if (activeKey === "security") return "Security";
  for (const group of NAV_GROUPS) {
    for (const tab of group.tabs) {
      if (tab.key === activeKey) return tab.label;
    }
  }
  return "Admin";
}

/**
 * Admin navigation bar with grouped tab sections.
 *
 * Desktop (>= 768px): horizontal grouped tabs with section labels
 * (Data, Marketing, Game, Content) plus user info and Security/Logout
 * on the right.
 *
 * Mobile (< 768px): collapses into a hamburger button + drawer overlay.
 * The drawer is rendered with the same group/tab tree but stacked vertically.
 * Touch targets meet the 44px minimum guideline. Tapping a tab or the
 * scrim closes the drawer; route changes also auto-close it.
 */
export default function AdminNav() {
  const { user, logout } = useAdminAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = getActiveTab(location.pathname);
  const activeLabel = getActiveLabel(activeTab);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);

  // Auto-close drawer when the route changes — covers both nav clicks
  // inside the drawer and external programmatic navigation.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Lock body scroll while drawer is open so the underlying page doesn't
  // scroll behind the overlay.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // Focus management: when the drawer opens, send focus to the close
  // button so screen readers / keyboard users land inside the dialog.
  // When it closes, return focus to the hamburger trigger so the user's
  // keyboard position is preserved.
  useEffect(() => {
    if (drawerOpen) {
      drawerCloseRef.current?.focus();
    } else {
      // Only refocus the hamburger if it was already mounted (i.e. not
      // the initial render). Use a ref check rather than a flag because
      // refs don't trigger re-renders.
      if (document.activeElement && document.activeElement !== document.body) {
        hamburgerRef.current?.focus();
      }
    }
  }, [drawerOpen]);

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // Error shown via context
    }
  }

  function handleNav(path: string) {
    navigate(path);
  }

  return (
    <nav className="admin-nav" data-testid="admin-nav">
      {/* Mobile-only header bar with hamburger + active page label */}
      <div className="admin-nav-mobile-header" data-testid="admin-nav-mobile-header">
        <button
          ref={hamburgerRef}
          type="button"
          className="admin-nav-hamburger"
          aria-label={drawerOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={drawerOpen}
          aria-controls="admin-nav-drawer"
          onClick={() => setDrawerOpen((v) => !v)}
          data-testid="admin-nav-hamburger"
        >
          <span className="admin-nav-hamburger-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
        <span className="admin-nav-mobile-title" data-testid="admin-nav-mobile-title">
          {activeLabel}
        </span>
        {user && (
          <span className="admin-nav-mobile-user" data-testid="admin-user-display-mobile">
            {user.username}
          </span>
        )}
      </div>

      {/* Desktop tab tree — hidden on mobile via CSS */}
      <div className="admin-nav-groups">
        {NAV_GROUPS.map((group) => (
          <div className="admin-nav-group" key={group.label}>
            <span className="admin-nav-group-label">{group.label}</span>
            <div className="admin-nav-group-tabs">
              {group.tabs.map((tab) => (
                <button
                  key={tab.key}
                  className={`admin-nav-link ${activeTab === tab.key ? "active" : ""}`}
                  onClick={() => handleNav(tab.path)}
                  data-testid={`admin-nav-${tab.key}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="admin-nav-user">
        <button
          className={`admin-nav-link ${activeTab === "security" ? "active" : ""}`}
          onClick={() => handleNav("/admin/security")}
          data-testid="admin-nav-security"
        >
          Security
        </button>
        {user && <span className="admin-nav-username" data-testid="admin-user-display">{user.username}</span>}
        <button onClick={handleLogout} className="admin-nav-logout" data-testid="admin-logout-btn">
          Logout
        </button>
      </div>

      {/* Mobile drawer + scrim — toggled by hamburger */}
      {drawerOpen && (
        <div
          className="admin-nav-drawer-scrim"
          onClick={() => setDrawerOpen(false)}
          data-testid="admin-nav-drawer-scrim"
          aria-hidden="true"
        />
      )}
      <div
        id="admin-nav-drawer"
        className={`admin-nav-drawer ${drawerOpen ? "open" : ""}`}
        data-testid="admin-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Admin navigation"
        aria-hidden={!drawerOpen}
      >
        <div className="admin-nav-drawer-header">
          <span className="admin-nav-drawer-title">Admin</span>
          <button
            ref={drawerCloseRef}
            type="button"
            className="admin-nav-drawer-close"
            aria-label="Close navigation menu"
            onClick={() => setDrawerOpen(false)}
            data-testid="admin-nav-drawer-close"
            tabIndex={drawerOpen ? 0 : -1}
          >
            ×
          </button>
        </div>
        <div className="admin-nav-drawer-body">
          {NAV_GROUPS.map((group) => (
            <div className="admin-nav-drawer-group" key={group.label}>
              <span className="admin-nav-drawer-group-label">{group.label}</span>
              {group.tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={`admin-nav-drawer-link ${activeTab === tab.key ? "active" : ""}`}
                  onClick={() => handleNav(tab.path)}
                  data-testid={`admin-nav-drawer-${tab.key}`}
                  tabIndex={drawerOpen ? 0 : -1}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ))}
          <div className="admin-nav-drawer-group">
            <span className="admin-nav-drawer-group-label">Account</span>
            <button
              type="button"
              className={`admin-nav-drawer-link ${activeTab === "security" ? "active" : ""}`}
              onClick={() => handleNav("/admin/security")}
              data-testid="admin-nav-drawer-security"
              tabIndex={drawerOpen ? 0 : -1}
            >
              Security
            </button>
            <button
              type="button"
              className="admin-nav-drawer-link admin-nav-drawer-logout"
              onClick={handleLogout}
              data-testid="admin-nav-drawer-logout"
              tabIndex={drawerOpen ? 0 : -1}
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
