/**
 * OAuth login buttons — renders "Continue with Google/Facebook/Amazon" links.
 * Only shows the divider and buttons when at least one provider is configured.
 * Uses <a> tags (not React Router Links) because OAuth redirects leave the SPA.
 */

interface OAuthButtonsProps {
  providers: { google: boolean; facebook: boolean; amazon: boolean };
}

/** Google "G" logo as inline SVG. */
function GoogleLogo() {
  return (
    <svg className="auth-oauth-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A11.96 11.96 0 0 0 1 12c0 1.94.46 3.77 1.18 5.07l3.66-2.98z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

/** Facebook "f" logo as inline SVG. */
function FacebookLogo() {
  return (
    <svg className="auth-oauth-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12S0 5.446 0 12.073c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" fill="#1877F2" />
    </svg>
  );
}

/** Amazon smile arrow logo as inline SVG. */
function AmazonLogo() {
  return (
    <svg className="auth-oauth-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M13.958 10.09c0 1.232.029 2.256-.591 3.351-.502.891-1.301 1.438-2.186 1.438-1.214 0-1.922-.924-1.922-2.292 0-2.692 2.415-3.182 4.7-3.182v.685zm3.186 7.705a.66.66 0 0 1-.753.077c-1.06-.879-1.247-1.287-1.832-2.122-1.75 1.784-2.991 2.318-5.26 2.318-2.686 0-4.772-1.657-4.772-4.972 0-2.588 1.402-4.349 3.398-5.208 1.73-.756 4.147-.891 5.993-1.1v-.41c0-.753.058-1.644-.384-2.294-.384-.578-1.117-.817-1.764-.817-1.199 0-2.265.615-2.526 1.89a.583.583 0 0 1-.501.504l-2.8-.302c-.238-.053-.502-.244-.434-.607C6.158 1.985 8.94.86 11.43.86c1.27 0 2.93.338 3.93 1.296 1.27 1.184 1.148 2.764 1.148 4.484v4.06c0 1.22.506 1.756.983 2.415.167.234.204.516-.01.69-.535.449-1.49 1.283-2.014 1.751l-.323.238z" fill="#FF9900" />
      <path d="M21.558 18.494c-2.062 1.522-5.05 2.332-7.621 2.332-3.607 0-6.856-1.333-9.312-3.553-.193-.175-.021-.413.211-.277 2.651 1.542 5.929 2.47 9.313 2.47 2.284 0 4.795-.474 7.107-1.456.349-.148.641.229.302.484z" fill="#FF9900" />
      <path d="M22.463 17.316c-.263-.337-1.74-.16-2.402-.081-.201.024-.232-.151-.051-.278 1.176-.826 3.106-.588 3.332-.311.226.279-.059 2.21-1.164 3.132-.17.142-.332.066-.256-.122.249-.619.806-2.003.541-2.34z" fill="#FF9900" />
    </svg>
  );
}

export default function OAuthButtons({ providers }: OAuthButtonsProps) {
  const hasAny = providers.google || providers.facebook || providers.amazon;
  if (!hasAny) return null;

  return (
    <>
      <div className="auth-divider">
        <span>or</span>
      </div>

      <div className="auth-oauth-buttons">
        {providers.google && (
          <a href="/api/user/oauth/google" className="btn auth-oauth-btn auth-oauth-google">
            <GoogleLogo />
            Continue with Google
          </a>
        )}
        {providers.facebook && (
          <a href="/api/user/oauth/facebook" className="btn auth-oauth-btn auth-oauth-facebook">
            <FacebookLogo />
            Continue with Facebook
          </a>
        )}
        {providers.amazon && (
          <a href="/api/user/oauth/amazon" className="btn auth-oauth-btn auth-oauth-amazon">
            <AmazonLogo />
            Continue with Amazon
          </a>
        )}
      </div>
    </>
  );
}
