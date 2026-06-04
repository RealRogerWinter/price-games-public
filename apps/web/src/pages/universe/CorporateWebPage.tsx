/**
 * Corporate web page for Product Universe.
 *
 * Search and browse companies, view their relationship networks.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import SearchBar from "../../components/universe/SearchBar";
import LoadingSpinner from "../../components/universe/LoadingSpinner";
import ErrorDisplay from "../../components/universe/ErrorDisplay";
import { puSearchCompanies } from "../../api/universeClient";

export default function CorporateWebPage() {
  const navigate = useNavigate();
  const [companies, setCompanies] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  function handleSearch(query: string) {
    setLoading(true);
    setError(null);
    puSearchCompanies(query)
      .then((data) => {
        setCompanies(data.companies);
        setSearched(true);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  return (
    <div className="pu-corporate-page">
      <div className="pu-page-header">
        <h1>Corporate Web</h1>
        <p>Explore companies and their relationships</p>
      </div>
      <SearchBar onSearch={handleSearch} placeholder="Search companies..." />

      {loading && <LoadingSpinner message="Searching companies..." />}
      {error && <ErrorDisplay message={error} />}

      {searched && companies.length === 0 && !loading && (
        <p className="pu-muted">No companies found. Try a different search term.</p>
      )}

      <div className="pu-company-list">
        {companies.map((c) => (
          <div
            key={c.id}
            className="pu-company-card"
            onClick={() => navigate(`/universe/company/${c.id}`)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && navigate(`/universe/company/${c.id}`)}
          >
            <h3>{c.name}</h3>
            {c.description && <p>{c.description.slice(0, 150)}...</p>}
            <div className="pu-company-meta">
              {c.headquarters && <span>{c.headquarters}</span>}
              {c.foundedYear && <span>Est. {c.foundedYear}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
