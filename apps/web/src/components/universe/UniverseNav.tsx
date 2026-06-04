/**
 * Navigation bar for Product Universe pages.
 *
 * Links to home, galaxy view, and companies.
 */

import { Link, useLocation } from "react-router-dom";

export default function UniverseNav() {
  const location = useLocation();

  const links = [
    { to: "/universe", label: "Search" },
    { to: "/universe/galaxy", label: "Galaxy" },
    { to: "/universe/companies", label: "Companies" },
  ];

  return (
    <nav className="pu-nav">
      <Link to="/universe" className="pu-nav-brand">Product Universe</Link>
      <div className="pu-nav-links">
        {links.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className={`pu-nav-link ${location.pathname === link.to ? "active" : ""}`}
          >
            {link.label}
          </Link>
        ))}
      </div>
      <Link to="/" className="pu-nav-link">Price Games</Link>
    </nav>
  );
}
