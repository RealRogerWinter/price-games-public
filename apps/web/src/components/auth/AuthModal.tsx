import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import LoginForm from "./LoginForm";
import RegisterForm from "./RegisterForm";
import { useGamePause } from "../../context/GamePauseContext";
import { useBroadcastMode } from "../../broadcast/useBroadcastMode";

interface AuthModalProps {
  onClose: () => void;
  initialMode?: "login" | "register";
}

/**
 * Modal overlay that switches between login and register forms.
 * Clicking the overlay closes the modal; clicking content does not.
 *
 * Pauses any active gameplay timer for the lifetime of the modal so that
 * registering mid-round doesn't let the round time out in the background.
 *
 * @param onClose - Callback to close the modal.
 * @param initialMode - Which form to show initially (defaults to "login").
 */
export default function AuthModal({ onClose, initialMode = "login" }: AuthModalProps) {
  const broadcast = useBroadcastMode();
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const navigate = useNavigate();
  const { pause, resume } = useGamePause();

  useEffect(() => {
    pause();
    return resume;
  }, [pause, resume]);

  // Mark the document while the modal is open so global CSS can hide
  // bright in-page chrome (the home-page VS pill, +25% / +10% bonus
  // bubbles, etc.) that would otherwise punch through the dim overlay.
  // Animated pills create their own GPU compositor layers and the
  // overlay's backdrop-filter doesn't reliably blur them, so a direct
  // CSS-driven hide is the cleanest fix. The class is on
  // <documentElement> so a single selector reaches everything.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("auth-modal-open");
    return () => {
      root.classList.remove("auth-modal-open");
    };
  }, []);

  function handleForgotPassword() {
    onClose();
    navigate("/forgot-password");
  }

  // Broadcast-mode renders for the 24/7 stream bot — auth modals must never
  // appear on stream. Hooks above still run so pause/resume + CSS class
  // toggles behave consistently if the parent toggles broadcast at runtime.
  if (broadcast) return null;

  return (
    <div className="auth-modal-overlay" onClick={onClose} data-testid="auth-modal-overlay">
      <div className="auth-modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="auth-modal-close" onClick={onClose}>&times;</button>
        {mode === "login" ? (
          <LoginForm
            onSwitchToRegister={() => setMode("register")}
            onForgotPassword={handleForgotPassword}
          />
        ) : (
          <RegisterForm onSwitchToLogin={() => setMode("login")} />
        )}
      </div>
    </div>
  );
}
