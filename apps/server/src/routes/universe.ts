/**
 * Product Universe REST API routes.
 *
 * Public endpoints under /api/pu/ for searching products, viewing enrichment
 * data, supply chain maps, galaxy visualization, and company graphs.
 * Rate-limited to 10 requests/minute per IP.
 *
 * Uses a factory pattern so tests can inject a custom database and AI provider.
 */

import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import type { AIProvider } from "../services/ai/types";
import { searchProducts, getProductDetail } from "../services/universe/productSearch";
import { generateSummaryCards } from "../services/universe/cardGenerator";
import { getSupplyChain, getProductMaterials } from "../services/universe/supplyChain";
import { getRelatedProducts } from "../services/universe/similarity";
import { getGalaxyData, getGalaxyForProduct } from "../services/universe/galaxy";
import { searchCompanies, getCompanyWithRelationships, getCompanyWeb } from "../services/universe/companyQuery";
import { getStats } from "../services/universe/stats";
import { safeErrorMessage } from "../services/errors";
import db from "../db";

/**
 * Create the Product Universe router.
 *
 * @param testDb - Optional database instance for testing.
 * @param testAi - Optional AI provider for testing.
 * @returns Express router with all /api/pu/ endpoints.
 */
export function createUniverseRouter(testDb?: DatabaseType, testAi?: AIProvider | null): Router {
  const router = Router();
  const database = testDb || db;

  // POST /search — search products (DB first, triggers enrichment)
  router.post("/search", (req: Request, res: Response) => {
    try {
      const { query, limit } = req.body as { query?: string; limit?: number };
      if (!query || typeof query !== "string" || query.trim().length === 0) {
        res.status(400).json({ error: "Search query is required" });
        return;
      }
      if (query.length > 200) {
        res.status(400).json({ error: "Query too long (max 200 characters)" });
        return;
      }
      const maxLimit = Math.min(limit || 20, 50);
      const result = searchProducts(database, query.trim(), maxLimit);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /product/:id — full product detail with enrichment data
  router.get("/product/:id", (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const detail = getProductDetail(database, id);
      if (!detail) {
        res.status(404).json({ error: "Product not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /product/:id/cards — AI-generated summary cards
  router.get("/product/:id/cards", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const cards = await generateSummaryCards(database, id, testAi);
      res.json({ cards });
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /product/:id/supply-chain — geographic supply chain data
  router.get("/product/:id/supply-chain", (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const nodes = getSupplyChain(database, id);
      res.json({ nodes });
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /product/:id/materials — materials breakdown
  router.get("/product/:id/materials", (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const materials = getProductMaterials(database, id);
      res.json({
        materials: materials.map((m) => ({
          id: m.id,
          name: m.name,
          category: m.category,
          description: m.description,
          sustainabilityScore: m.sustainability_score,
          percentage: m.percentage,
          confidence: m.confidence,
          sourceUrl: m.source_url,
          sourceTitle: m.source_title,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /product/:id/related — similar products
  router.get("/product/:id/related", (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const limit = Math.min(parseInt(String(req.query.limit || ""), 10) || 10, 50);
      const related = getRelatedProducts(database, id, limit);
      res.json({
        related: related.map((r) => ({
          id: r.id,
          title: r.title,
          imageUrl: r.image_url,
          category: r.category,
          manufacturer: r.manufacturer,
          score: r.score,
          reason: r.reason,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /galaxy — 3D galaxy data (up to 5000 nodes)
  router.get("/galaxy", (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || ""), 10) || 5000, 5000);
      const nodes = getGalaxyData(database, limit);
      res.json({ nodes });
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /galaxy/product/:id — galaxy centered on one product
  router.get("/galaxy/product/:id", (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const nodes = getGalaxyForProduct(database, id);
      res.json({ nodes });
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /companies — search companies
  router.get("/companies", (req: Request, res: Response) => {
    try {
      const query = (req.query.q as string) || "";
      const limit = Math.min(parseInt(String(req.query.limit || ""), 10) || 20, 50);
      const companies = searchCompanies(database, query, limit);
      res.json({
        companies: companies.map((c: any) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          website: c.website,
          logoUrl: c.logo_url,
          foundedYear: c.founded_year,
          headquarters: c.headquarters,
          employeeCount: c.employee_count,
          revenue: c.revenue,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /company/:id — company detail + relationships
  router.get("/company/:id", (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid company ID" });
        return;
      }
      const company = getCompanyWithRelationships(database, id);
      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      res.json(company);
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /company/:id/web — corporate relationship graph data
  router.get("/company/:id/web", (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "Invalid company ID" });
        return;
      }
      const web = getCompanyWeb(database, id);
      if (!web) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      res.json(web);
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // GET /stats — public stats
  router.get("/stats", (_req: Request, res: Response) => {
    try {
      const stats = getStats(database);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  return router;
}
