/**
 * Search results page for Product Universe.
 *
 * Shows a list of matching products, with enrichment status indicators
 * and links to detailed product exploration.
 */

import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import SearchBar from "../../components/universe/SearchBar";
import PUProductCard from "../../components/universe/PUProductCard";
import LoadingSpinner from "../../components/universe/LoadingSpinner";
import ErrorDisplay from "../../components/universe/ErrorDisplay";
import { puSearch } from "../../api/universeClient";
import type { PUSearchResult } from "@price-game/shared";

export default function SearchResultsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const query = searchParams.get("q") || "";
  const [results, setResults] = useState<PUSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query) return;
    setLoading(true);
    setError(null);
    puSearch(query)
      .then(setResults)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [query]);

  function handleSearch(newQuery: string) {
    navigate(`/universe/search?q=${encodeURIComponent(newQuery)}`);
  }

  return (
    <div className="pu-search-results">
      <SearchBar onSearch={handleSearch} initialQuery={query} />

      {loading && <LoadingSpinner message="Searching products..." />}
      {error && <ErrorDisplay message={error} onRetry={() => handleSearch(query)} />}

      {results && (
        <>
          <p className="pu-results-count">
            {results.total} result{results.total !== 1 ? "s" : ""} for "{query}"
            {results.enrichmentTriggered && (
              <span className="pu-enrichment-notice"> — enrichment has been triggered for new products</span>
            )}
          </p>
          <div className="pu-results-grid">
            {results.products.map((p) => (
              <PUProductCard key={p.id} {...p} />
            ))}
          </div>
        </>
      )}

      {results && results.products.length === 0 && (
        <p className="pu-muted">No products found matching "{query}".</p>
      )}
    </div>
  );
}
