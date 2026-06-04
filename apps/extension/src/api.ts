// Admin API is only accessible via Tailscale. The production Tailscale
// hostname is injected at build time via VITE_EXTENSION_API_BASE so we don't
// commit the operator's tailnet identity. See docs/DEPLOYMENT.md#tailscale.
const API_BASE =
  (import.meta.env.VITE_EXTENSION_API_BASE as string | undefined) ??
  "http://localhost:3001/api/admin";

export interface LoginResponse { token: string; user: { id: string; username: string; canUseExtension: boolean }; }
export interface ImportResponse { product: { id: number; asin: string; title: string; priceCents: number; category: string | null; manufacturer: string | null; isActive: boolean }; created: boolean; }

async function apiFetch(path: string, token: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers as Record<string, string>) } });
}

export async function extensionLogin(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/extension/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!res.ok) { const body = await res.json().catch(() => ({ error: "Login failed" })); throw new Error(body.error || `Login failed (${res.status})`); }
  return res.json();
}

export async function importProduct(token: string, data: { asin: string; title: string; priceCents: number; imageUrl?: string; description?: string; category?: string; manufacturer?: string }): Promise<ImportResponse> {
  const res = await apiFetch("/extension/import", token, { method: "POST", body: JSON.stringify(data) });
  if (!res.ok) { const body = await res.json().catch(() => ({ error: "Import failed" })); throw new Error(body.error || `Import failed (${res.status})`); }
  return res.json();
}

/** Verify the session token is still valid server-side. */
export async function verifySession(token: string): Promise<boolean> {
  try {
    const res = await apiFetch("/extension/verify", token);
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchCategories(token: string): Promise<string[]> {
  const res = await apiFetch("/products/categories", token);
  if (!res.ok) return [];
  return res.json();
}
