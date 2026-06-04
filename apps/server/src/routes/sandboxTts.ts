/**
 * Sandbox-only diagnostic route. POST /api/sandbox/tts/cycle-moods
 * triggers a per-mood lipsync test that drives real Piper subprocesses
 * through the production UtteranceController + PcmBatcher and emits
 * envelopes to all broadcast clients via Socket.IO. The page-side
 * relay hook re-issues each as a `window.postMessage` so the overlay
 * reducer + Avatar viseme classifier exercise the exact code path
 * the production runner uses.
 *
 * The route is mounted only when the server boots with SANDBOX=1
 * (see `index.ts`). Production never exposes this surface.
 */
import { Router, type Request, type Response } from "express";
import type { Server } from "socket.io";
import { runCycleMoods } from "../services/sandboxTts/cycleMoods";

/**
 * Build the sandbox TTS router.
 *
 * @param io Socket.IO server. Envelopes are broadcast to every
 *   connected client; the relay hook on the broadcast page filters
 *   for them.
 */
export function createSandboxTtsRouter(io: Server): Router {
  const router = Router();
  // In-flight guard: only one cycle at a time. A second click while
  // the first is still running is a no-op (returns 429) so audio
  // doesn't overlap. Production-style serial queuing would also work
  // but for a debug endpoint "reject second concurrent click" is
  // simpler + clearer feedback.
  let running = false;

  router.post("/cycle-moods", async (_req: Request, res: Response) => {
    if (running) {
      res.status(429).json({ error: "cycle already running" });
      return;
    }
    running = true;
    // Respond immediately so the page doesn't keep an HTTP request
    // pending for ~30s while audio plays. The actual TTS lifecycle
    // is observed via the Socket.IO envelopes.
    res.json({ ok: true, status: "started" });
    try {
      const summary = await runCycleMoods(io, {
        onLog: (line) => console.log(line),
      });
      console.log(`[sandbox-tts] cycle complete; ${summary.length} moods`);
    } catch (err) {
      console.error(`[sandbox-tts] cycle failed:`, err);
    } finally {
      running = false;
    }
  });

  return router;
}
