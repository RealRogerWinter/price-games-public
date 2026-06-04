/**
 * Main Product Universe page.
 *
 * Unified view with search bar above a 3D galaxy. Searching or clicking
 * a star opens a full-screen product dashboard modal. Search results
 * appear as a card grid between the search bar and the galaxy.
 */

import { useState, useEffect } from "react";
import GalaxyView from "../../components/universe/GalaxyView";
import ProductDashboard from "../../components/universe/ProductDashboard";
import SearchBar from "../../components/universe/SearchBar";
import PUProductCard from "../../components/universe/PUProductCard";
import LoadingSpinner from "../../components/universe/LoadingSpinner";
import ErrorDisplay from "../../components/universe/ErrorDisplay";
import { puGetGalaxy, puSearch } from "../../api/universeClient";
import type { PUGalaxyNode, PUSearchResult } from "@price-game/shared";

export default function GalaxyPage() {
  const [nodes, setNodes] = useState<PUGalaxyNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [hoveredNode, setHoveredNode] = useState<PUGalaxyNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // Search state
  const [searchResults, setSearchResults] = useState<PUSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    puGetGalaxy()
      .then((data) => setNodes(data.nodes))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function handleSearch(query: string) {
    setSearching(true);
    setSearchError(null);
    puSearch(query)
      .then(setSearchResults)
      .catch((err) => setSearchError(err.message))
      .finally(() => setSearching(false));
  }

  function handleNodeClick(productId: number) {
    setSelectedProductId(productId);
  }

  function handleNodeHover(
    node: PUGalaxyNode | null,
    screenPos: { x: number; y: number } | null,
  ) {
    setHoveredNode(node);
    setTooltipPos(screenPos);
  }

  function handleProductCardClick(productId: number) {
    setSelectedProductId(productId);
  }

  if (loading) return <LoadingSpinner message="Loading galaxy..." />;
  if (error) return <ErrorDisplay message={error} onRetry={() => window.location.reload()} />;

  return (
    <div className="pu-galaxy-page">
      <div className="pu-galaxy-search-area">
        <SearchBar onSearch={handleSearch} placeholder="Search products to explore..." />
      </div>

      {/* Search results grid */}
      {searching && <LoadingSpinner message="Searching..." />}
      {searchError && <ErrorDisplay message={searchError} />}
      {searchResults && searchResults.products.length > 0 && (
        <div className="pu-galaxy-results">
          <div className="pu-galaxy-results-header">
            <span>{searchResults.total} result{searchResults.total !== 1 ? "s" : ""}</span>
            <button
              className="pu-galaxy-results-clear"
              onClick={() => setSearchResults(null)}
            >
              Clear
            </button>
          </div>
          <div className="pu-results-grid">
            {searchResults.products.map((p) => (
              <div key={p.id} onClick={() => handleProductCardClick(p.id)} style={{ cursor: "pointer" }}>
                <PUProductCard {...p} />
              </div>
            ))}
          </div>
        </div>
      )}
      {searchResults && searchResults.products.length === 0 && (
        <p className="pu-muted">No products found.</p>
      )}

      {/* Galaxy */}
      <div className="pu-galaxy-section">
        <p className="pu-galaxy-count">
          {nodes.length.toLocaleString()} products mapped — click a star to explore
        </p>
        <GalaxyView
          nodes={nodes}
          onNodeClick={handleNodeClick}
          onNodeHover={handleNodeHover}
        />
      </div>

      {/* Tooltip */}
      {hoveredNode && tooltipPos && !selectedProductId && (
        <div
          className="pu-galaxy-tooltip"
          style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 8 }}
        >
          <h4>{hoveredNode.title}</h4>
          {hoveredNode.category && <p>{hoveredNode.category}</p>}
        </div>
      )}

      {/* Dashboard modal */}
      {selectedProductId !== null && (
        <ProductDashboard
          productId={selectedProductId}
          onClose={() => setSelectedProductId(null)}
        />
      )}
    </div>
  );
}
