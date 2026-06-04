import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useUserAuth } from "../../context/UserAuthContext";
import AuthModal from "./AuthModal";
import AvatarIcon from "../multiplayer/AvatarIcon";

/**
 * Navigation bar for user authentication.
 * When logged out: shows "Log In" and "Sign Up" buttons that open the AuthModal.
 * When logged in: shows username, "Profile" link, and "Log Out" button.
 * Manages its own modal state internally.
 */
export default function UserNavBar() {
  const { user, isAuthenticated, logout } = useUserAuth();
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<"login" | "register">("login");

  // Close modal when user successfully authenticates
  useEffect(() => {
    if (isAuthenticated) {
      setShowModal(false);
    }
  }, [isAuthenticated]);

  function handleOpenLogin() {
    setModalMode("login");
    setShowModal(true);
  }

  function handleOpenRegister() {
    setModalMode("register");
    setShowModal(true);
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // Error is already set in context
    }
  }

  return (
    <div className="auth-nav">
      {isAuthenticated && user ? (
        <>
          {user.avatar && <AvatarIcon avatar={user.avatar} size={24} />}
          <span className="auth-nav-username">{user.username}</span>
          <Link to="/settings" className="btn-top auth-nav-profile">Settings</Link>
          <button className="btn-top auth-nav-logout" onClick={handleLogout}>
            Log Out
          </button>
        </>
      ) : (
        <>
          <button className="btn-top auth-nav-login" onClick={handleOpenLogin}>
            Log In
          </button>
          <button className="btn-top auth-nav-signup" onClick={handleOpenRegister}>
            Sign Up
          </button>
        </>
      )}

      {showModal && (
        <AuthModal
          onClose={() => setShowModal(false)}
          initialMode={modalMode}
        />
      )}
    </div>
  );
}
