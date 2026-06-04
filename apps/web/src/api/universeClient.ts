/**
 * REST client for Product Universe API (/api/pu/*).
 *
 * All functions throw on non-OK responses for consistent error handling.
 */

import type {
  PUSearchResult,
  PUProductDetail,
  PUSummaryCard,
  PUGalaxyNode,
  PUCompanyWithRelationships,
  PUStats,
} from "@price-game/shared";

/** Material item returned from the materials endpoint with optional source info. */
export interface PUMaterialResponse {
  id: number;
  name: string;
  category: string | null;
  description: string | null;
  sustainabilityScore: number | null;
  percentage: number | null;
  confidence: string;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
}

const BASE = "/api/pu";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** Search products by query. */
export function puSearch(query: string, limit?: number): Promise<PUSearchResult> {
  return fetchJson(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
}

/** Get full product detail with enrichment data. */
export function puGetProduct(id: number): Promise<PUProductDetail> {
  return fetchJson(`${BASE}/product/${id}`);
}

/** Get AI-generated summary cards for a product. */
export function puGetCards(id: number): Promise<{ cards: PUSummaryCard[] }> {
  return fetchJson(`${BASE}/product/${id}/cards`);
}

/** Get supply chain data for a product. */
export function puGetSupplyChain(id: number): Promise<{ nodes: any[] }> {
  return fetchJson(`${BASE}/product/${id}/supply-chain`);
}

/** Get materials breakdown for a product. */
export function puGetMaterials(id: number): Promise<{ materials: PUMaterialResponse[] }> {
  return fetchJson(`${BASE}/product/${id}/materials`);
}

/** Get related products for a product. */
export function puGetRelated(id: number, limit?: number): Promise<{ related: any[] }> {
  const params = limit ? `?limit=${limit}` : "";
  return fetchJson(`${BASE}/product/${id}/related${params}`);
}

/** Get full galaxy data. */
export function puGetGalaxy(limit?: number): Promise<{ nodes: PUGalaxyNode[] }> {
  const params = limit ? `?limit=${limit}` : "";
  return fetchJson(`${BASE}/galaxy${params}`);
}

/** Get galaxy data centered on one product. */
export function puGetGalaxyForProduct(id: number): Promise<{ nodes: PUGalaxyNode[] }> {
  return fetchJson(`${BASE}/galaxy/product/${id}`);
}

/** Search companies. */
export function puSearchCompanies(query: string, limit?: number): Promise<{ companies: any[] }> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (limit) params.set("limit", String(limit));
  return fetchJson(`${BASE}/companies?${params}`);
}

/** Get company detail with relationships. */
export function puGetCompany(id: number): Promise<PUCompanyWithRelationships> {
  return fetchJson(`${BASE}/company/${id}`);
}

/** Get company relationship web for graph visualization. */
export function puGetCompanyWeb(id: number): Promise<{ nodes: any[]; edges: any[] }> {
  return fetchJson(`${BASE}/company/${id}/web`);
}

/** Get public stats. */
export function puGetStats(): Promise<PUStats> {
  return fetchJson(`${BASE}/stats`);
}
