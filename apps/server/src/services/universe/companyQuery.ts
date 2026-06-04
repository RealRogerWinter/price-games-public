/**
 * Company query service for Product Universe.
 *
 * Provides search and detail retrieval for companies in the
 * knowledge graph, including their relationship networks.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { PUCompany, PUCompanyWithRelationships, PUCompanyRole } from "@price-game/shared";

/**
 * Search companies by name.
 *
 * @param db - Database instance.
 * @param query - Search query.
 * @param limit - Max results (default 20).
 * @returns Array of matching companies.
 */
export function searchCompanies(db: DatabaseType, query: string, limit: number = 20): PUCompany[] {
  const searchTerm = `%${query}%`;
  return db.prepare(
    `SELECT id, name, description, website, logo_url, founded_year,
            headquarters, employee_count, revenue, created_at, updated_at
     FROM pu_companies
     WHERE name LIKE ?
     ORDER BY name
     LIMIT ?`
  ).all(searchTerm, limit) as any[];
}

/**
 * Get a company with all its relationships and linked products.
 *
 * @param db - Database instance.
 * @param companyId - Company ID.
 * @returns Company with relationships, or null if not found.
 */
export function getCompanyWithRelationships(
  db: DatabaseType,
  companyId: number,
): PUCompanyWithRelationships | null {
  const company = db.prepare(
    `SELECT id, name, description, website, logo_url, founded_year,
            headquarters, employee_count, revenue, created_at, updated_at
     FROM pu_companies WHERE id = ?`
  ).get(companyId) as any;

  if (!company) return null;

  const relationships = db.prepare(
    `SELECT cr.id, cr.company_id, cr.related_company_id, cr.relationship_type, cr.confidence,
            c.name, c.description, c.website, c.headquarters,
            s.url as source_url, s.title as source_title
     FROM pu_company_relationships cr
     JOIN pu_companies c ON c.id = cr.related_company_id
     LEFT JOIN pu_sources s ON s.id = cr.source_id
     WHERE cr.company_id = ?`
  ).all(companyId) as any[];

  // Also get reverse relationships (where this company is the related one)
  const reverseRelationships = db.prepare(
    `SELECT cr.id, cr.company_id, cr.related_company_id, cr.relationship_type, cr.confidence,
            c.name, c.description, c.website, c.headquarters,
            s.url as source_url, s.title as source_title
     FROM pu_company_relationships cr
     JOIN pu_companies c ON c.id = cr.company_id
     LEFT JOIN pu_sources s ON s.id = cr.source_id
     WHERE cr.related_company_id = ?`
  ).all(companyId) as any[];

  const products = db.prepare(
    `SELECT p.id, p.title, pc.role, pc.confidence,
            s.url as source_url, s.title as source_title
     FROM pu_product_companies pc
     JOIN products p ON p.id = pc.product_id
     LEFT JOIN pu_sources s ON s.id = pc.source_id
     WHERE pc.company_id = ?
     ORDER BY p.title`
  ).all(companyId) as { id: number; title: string; role: PUCompanyRole; confidence: string; source_url: string | null; source_title: string | null }[];

  return {
    id: company.id,
    name: company.name,
    description: company.description,
    website: company.website,
    headquarters: company.headquarters,
    revenue: company.revenue,
    logoUrl: company.logo_url,
    foundedYear: company.founded_year,
    employeeCount: company.employee_count,
    createdAt: company.created_at,
    updatedAt: company.updated_at,
    relationships: [
      ...relationships.map((r: any) => ({
        id: r.id,
        companyId: r.company_id,
        relatedCompanyId: r.related_company_id,
        relationshipType: r.relationship_type,
        confidence: r.confidence,
        sourceId: null,
        sourceUrl: r.source_url && !r.source_url.startsWith("ai:") ? r.source_url : null,
        sourceTitle: r.source_title,
        relatedCompany: {
          id: r.related_company_id,
          name: r.name,
          description: r.description,
          website: r.website,
          headquarters: r.headquarters,
          logoUrl: null,
          foundedYear: null,
          employeeCount: null,
          revenue: null,
          createdAt: "",
          updatedAt: "",
        },
      })),
      ...reverseRelationships.map((r: any) => ({
        id: r.id,
        companyId: r.related_company_id,
        relatedCompanyId: r.company_id,
        relationshipType: r.relationship_type,
        confidence: r.confidence,
        sourceId: null,
        sourceUrl: r.source_url && !r.source_url.startsWith("ai:") ? r.source_url : null,
        sourceTitle: r.source_title,
        relatedCompany: {
          id: r.company_id,
          name: r.name,
          description: r.description,
          website: r.website,
          headquarters: r.headquarters,
          logoUrl: null,
          foundedYear: null,
          employeeCount: null,
          revenue: null,
          createdAt: "",
          updatedAt: "",
        },
      })),
    ],
    products: products.map((p) => ({
      id: p.id,
      title: p.title,
      role: p.role,
      confidence: p.confidence,
      sourceUrl: p.source_url && !p.source_url.startsWith("ai:") ? p.source_url : null,
      sourceTitle: p.source_title,
    })),
  };
}

/**
 * Get company relationship web data for graph visualization.
 *
 * @param db - Database instance.
 * @param companyId - Center company ID.
 * @returns Nodes and edges for a force-directed graph.
 */
export function getCompanyWeb(db: DatabaseType, companyId: number) {
  const company = getCompanyWithRelationships(db, companyId);
  if (!company) return null;

  type NodeType = "center" | "related";
  const nodes: { id: number; name: string; type: NodeType; productCount: number }[] = [
    { id: company.id, name: company.name, type: "center", productCount: company.products.length },
  ];
  const edges: { source: number; target: number; type: string }[] = [];
  const seen = new Set<number>([company.id]);

  for (const rel of company.relationships) {
    const relatedId = rel.relatedCompany.id || rel.relatedCompanyId;
    if (!seen.has(relatedId)) {
      nodes.push({
        id: relatedId,
        name: rel.relatedCompany.name || "Unknown",
        type: "related",
        productCount: 0,
      });
      seen.add(relatedId);
    }
    edges.push({
      source: company.id,
      target: relatedId,
      type: rel.relationshipType,
    });
  }

  return { nodes, edges };
}
