/**
 * Root component for the Product Universe section.
 *
 * Sets up sub-routes under /universe/* and wraps all pages in
 * the shared UniverseLayout. Heavy visualization pages (map, galaxy,
 * company graph) are lazy-loaded to avoid pulling Three.js/Leaflet/D3
 * into the initial bundle.
 */

import { Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import UniverseLayout from "../../components/universe/UniverseLayout";
import LoadingSpinner from "../../components/universe/LoadingSpinner";
import UniverseHomePage from "./UniverseHomePage";
import SearchResultsPage from "./SearchResultsPage";
import lazyWithRetry from "../../utils/lazyWithRetry";

const ProductExplorePage = lazyWithRetry(() => import("./ProductExplorePage"));
const SupplyChainMapPage = lazyWithRetry(() => import("./SupplyChainMapPage"));
const GalaxyPage = lazyWithRetry(() => import("./GalaxyPage"));
const CorporateWebPage = lazyWithRetry(() => import("./CorporateWebPage"));
const CompanyDetailPage = lazyWithRetry(() => import("./CompanyDetailPage"));

export default function UniverseApp() {
  return (
    <UniverseLayout>
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route index element={<UniverseHomePage />} />
          <Route path="search" element={<SearchResultsPage />} />
          <Route path="product/:id" element={<ProductExplorePage />} />
          <Route path="product/:id/map" element={<SupplyChainMapPage />} />
          <Route path="galaxy" element={<GalaxyPage />} />
          <Route path="companies" element={<CorporateWebPage />} />
          <Route path="company/:id" element={<CompanyDetailPage />} />
        </Routes>
      </Suspense>
    </UniverseLayout>
  );
}
