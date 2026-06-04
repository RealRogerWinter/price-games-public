/**
 * Image proxy route.
 *
 * Serves product images for `/api/image/:productId`. Extracted into a router
 * factory so the handler can be integration-tested in isolation. The
 * `imageLimiter` middleware is mounted by the caller because the rate limit
 * is a deployment-time concern and we don't want tests tripping on it.
 */

import express, { type Router } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import { fetchProductImage } from "../services/imageProxy";

/**
 * Create the image proxy router.
 *
 * @param getDb - Lazy DB accessor so tests can inject a fixture DB per suite.
 * @returns An Express router exposing `GET /:productId`.
 */
export function createImageRouter(getDb: () => DatabaseType): Router {
  const router = express.Router();

  router.get("/:productId", async (req, res) => {
    const startedAt = Date.now();
    // Log response-stream aborts so we can correlate backend aborts with
    // client-side image-failure reports. iOS Safari is known to RST_STREAM
    // slow image requests without firing `error` on the <img>.
    //
    // We only log aborts that took >2s. Ordinary React key-swap cancels on
    // round change are fast and would otherwise flood the log — the signal
    // we care about is stalled requests where iOS eventually sent RST_STREAM.
    res.on("close", () => {
      const durationMs = Date.now() - startedAt;
      if (!res.writableEnded && durationMs > 2000) {
        // eslint-disable-next-line no-console
        console.warn("[image-proxy] aborted", {
          productId: req.params.productId,
          durationMs,
          ua: req.headers["user-agent"] || "",
        });
      }
    });
    try {
      if (!/^\d+$/.test(req.params.productId)) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
        res.status(400).send("Invalid product ID");
        return;
      }
      const result = await fetchProductImage(req.params.productId, getDb());
      if (!result) {
        // no-store is essential on 404 so iOS Safari does not hold a broken
        // image in its heuristic-freshness window if the product is later
        // re-populated (e.g. ASIN scrape succeeds on a retry).
        res.setHeader("Cache-Control", "no-store, must-revalidate");
        res.status(404).send("Not found");
        return;
      }
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(result.buffer);
    } catch {
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      res.status(500).send("Error");
    }
  });

  return router;
}
