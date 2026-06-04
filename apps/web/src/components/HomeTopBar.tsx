import UserDropdown from "./auth/UserDropdown";

/**
 * Home-screen navigation chip. Floats in the top-right of the hero area
 * via `position: absolute` (see `.top-bar--home` in index.css) so it
 * shares vertical space with the logo instead of displacing it. The
 * left slot is rendered for structural parity with the gameplay
 * {@link TopBar} but hidden by CSS — both home (`/`) and the
 * multiplayer hub (`/mp`) now show only the auth / user menu on the
 * right; clicking the centered logo handles home routing.
 */
export default function HomeTopBar() {
  return (
    <div className="top-bar top-bar--home">
      <div className="top-bar-left" />
      <UserDropdown />
    </div>
  );
}
