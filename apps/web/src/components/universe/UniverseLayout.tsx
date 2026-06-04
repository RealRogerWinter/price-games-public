/**
 * Shared layout wrapper for all Product Universe pages.
 *
 * Provides consistent navigation header, main content area, and footer.
 */

import { ReactNode } from "react";
import UniverseNav from "./UniverseNav";

interface UniverseLayoutProps {
  children: ReactNode;
}

export default function UniverseLayout({ children }: UniverseLayoutProps) {
  return (
    <div className="pu-layout">
      <UniverseNav />
      <main className="pu-main">{children}</main>
      <footer className="pu-footer">
        <p>Product Universe — Powered by AI-assisted research</p>
      </footer>
    </div>
  );
}
