import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useUserAuth } from "../../context/UserAuthContext";
import AuthModal from "./AuthModal";
import AvatarIcon from "../multiplayer/AvatarIcon";

/**
 * Avatar placeholder: a small circle with a person silhouette SVG.
 * @param size - diameter in pixels (default 28)
 */
function AvatarPlaceholder({ size = 28 }: { size?: number }) {
  return (
    <span
      className="user-dropdown-avatar"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" fill="none" width={size * 0.6} height={size * 0.6}>
        <circle cx="12" cy="8" r="4" fill="currentColor" />
        <path d="M4 20c0-4 4-7 8-7s8 3 8 7" fill="currentColor" />
      </svg>
    </span>
  );
}

/** Format a score into a compact abbreviated string (e.g. 1.2K, 3.4M). */
function formatCompactScore(score: number): string {
  if (score >= 1_000_000) return `${(score / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (score >= 1_000) return `${(score / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(score);
}

interface UserDropdownProps {
  /** "topbar" (default) renders compact; "home" renders larger for the home page toolbar. */
  variant?: "topbar" | "home";
}

/**
 * User dropdown for the top bar and home page.
 * Logged in: avatar + username trigger that opens a dropdown with Scoreboard, Settings, and Log Out.
 * Logged out: Log In and Sign Up buttons that open AuthModal.
 */
export default function UserDropdown({ variant = "topbar" }: UserDropdownProps) {
  const { user, isAuthenticated, logout } = useUserAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<"login" | "register">("login");
  const menuRef = useRef<HTMLDivElement>(null);

  // Close modal on successful auth
  useEffect(() => {
    if (isAuthenticated) setShowModal(false);
  }, [isAuthenticated]);

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, close]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, close]);

  async function handleLogout() {
    close();
    try {
      await logout();
    } catch {
      // Error is already set in context
    }
  }

  function handleSettings() {
    close();
    navigate("/settings");
  }

  function handleScoreboard() {
    close();
    navigate("/scoreboard");
  }

  function handleLeaderboard() {
    close();
    navigate("/?view=leaderboard");
  }

  const isHome = variant === "home";
  const btnClass = isHome ? "home-toolbar-btn" : "btn-top";

  if (!isAuthenticated || !user) {
    return (
      <div className={`auth-nav${isHome ? " auth-nav--home" : ""}`}>
        <button
          className={`${btnClass} auth-nav-login`}
          onClick={() => { setModalMode("login"); setShowModal(true); }}
        >
          Log In
        </button>
        <button
          className={`${btnClass} auth-nav-signup`}
          onClick={() => { setModalMode("register"); setShowModal(true); }}
        >
          Sign Up
        </button>
        {showModal && (
          <AuthModal
            onClose={() => setShowModal(false)}
            initialMode={modalMode}
          />
        )}
      </div>
    );
  }

  return (
    <div className={`user-dropdown${isHome ? " user-dropdown--home" : ""}`} ref={menuRef}>
      <button
        className={`user-dropdown-trigger${isHome ? " user-dropdown-trigger--home" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {user.avatar ? (
          <AvatarIcon avatar={user.avatar} size={isHome ? 32 : 26} />
        ) : (
          <AvatarPlaceholder size={isHome ? 32 : 26} />
        )}
        <span className="user-dropdown-username">{user.username}</span>
        <svg
          className="user-dropdown-chevron"
          viewBox="0 0 12 12"
          width="10"
          height="10"
          style={{ transform: open ? "rotate(180deg)" : undefined }}
        >
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="user-dropdown-panel" role="menu">
          <div className="user-dropdown-header">
            {user.avatar ? (
              <AvatarIcon avatar={user.avatar} size={36} />
            ) : (
              <AvatarPlaceholder size={36} />
            )}
            <div className="user-dropdown-header-info">
              <span className="user-dropdown-header-name">{user.username}</span>
              {user.email && (
                <span className="user-dropdown-header-email">{user.email}</span>
              )}
            </div>
          </div>
          <div className="user-dropdown-divider" />
          <button
            className="user-dropdown-item"
            onClick={handleScoreboard}
            role="menuitem"
          >
            My Scores
            <span className="user-dropdown-item-badge">
              {formatCompactScore(user.lifetimeScore)}
            </span>
          </button>
          <button
            className="user-dropdown-item"
            onClick={handleLeaderboard}
            role="menuitem"
          >
            Leaderboard
          </button>
          <button
            className="user-dropdown-item"
            onClick={handleSettings}
            role="menuitem"
          >
            Settings
          </button>
          <button
            className="user-dropdown-item user-dropdown-item--danger"
            onClick={handleLogout}
            role="menuitem"
          >
            Log Out
          </button>
        </div>
      )}
    </div>
  );
}
