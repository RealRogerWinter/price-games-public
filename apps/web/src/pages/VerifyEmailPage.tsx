import { useState, useEffect, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { userVerifyEmail } from "../api/userClient";
import { useUserAuth } from "../context/UserAuthContext";

/**
 * Processes an email verification token from the URL and displays the result.
 * Linked from the verification email sent during registration or email change.
 */
export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser } = useUserAuth();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const calledRef = useRef(false);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("No verification token provided");
      return;
    }

    // Guard against React StrictMode double-mount
    if (calledRef.current) return;
    calledRef.current = true;

    userVerifyEmail(token)
      .then(() => {
        setStatus("success");
        refreshUser();
      })
      .catch((err) => {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Verification failed");
      });
  }, [token, refreshUser]);

  return (
    <div className="app">
      <div className="auth-page">
        <div className="auth-page-card">
          <h1 className="auth-form-title">Email Verification</h1>

          {status === "loading" && (
            <p className="auth-page-text">Verifying your email...</p>
          )}

          {status === "success" && (
            <>
              <p className="auth-page-text auth-page-success">
                Your email has been verified successfully!
              </p>
              <button
                className="btn btn-primary auth-submit"
                onClick={() => navigate("/")}
              >
                Go to Home
              </button>
            </>
          )}

          {status === "error" && (
            <>
              <p className="auth-error">{error}</p>
              <button
                className="btn btn-primary auth-submit"
                onClick={() => navigate("/")}
              >
                Go to Home
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
