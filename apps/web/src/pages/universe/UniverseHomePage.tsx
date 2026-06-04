/**
 * Product Universe home page.
 *
 * Search bar with stats display. Entry point for product exploration.
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import SearchBar from "../../components/universe/SearchBar";
import StatsDisplay from "../../components/universe/StatsDisplay";
import { puGetStats } from "../../api/universeClient";
import type { PUStats } from "@price-game/shared";

export default function UniverseHomePage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<PUStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    puGetStats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function handleSearch(query: string) {
    navigate(`/universe/search?q=${encodeURIComponent(query)}`);
  }

  return (
    <div className="pu-home">
      <div className="pu-home-hero">
        <h1>Product Universe</h1>
        <p>Explore the story behind any product — materials, supply chains, companies, and connections.</p>
        <SearchBar onSearch={handleSearch} />
      </div>
      <StatsDisplay stats={stats} loading={loading} />
    </div>
  );
}
