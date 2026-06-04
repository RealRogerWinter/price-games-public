/**
 * Client-side analytics beacon endpoint.
 *
 * Accepts batched events from the web client and feeds them into the unified
 * {@link recordEvent} ingest path. This is the **engagement-only** capture
 * path — server-side auto-capture (game lifecycle, auth, MP) does not go
 * through this endpoint and cannot be bypassed by a blocked client.
 *
 * Dedup: each event carries a `clientEventId` (UUIDv4). A unique partial
 * index on `events(visitor_id, client_event_id)` absorbs retries.
 *
 * Privacy: DNT / Sec-GPC headers are honoured by {@link recordEvent};
 * when either is set, the event is stored with UA/geo/properties stripped.
 */

import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config";
import { recordEventFromRequest } from "../services/eventLog";
import { ANALYTICS_EVENTS, BEACON_MAX_EVENTS, type BeaconEnvelope } from "@price-game/shared";

/**
 * Names the client beacon is allowed to emit. Game lifecycle and auth events
 * must come from the server side so an attacker can't fabricate e.g. a
 * `game_completed` event to poison the dashboards.
 */
const CLIENT_EVENT_ALLOWLIST: ReadonlySet<string> = new Set([
  ANALYTICS_EVENTS.PAGE_VIEWED,
  ANALYTICS_EVENTS.SHARE_CLICKED,
  ANALYTICS_EVENTS.LEADERBOARD_VIEWED,
  ANALYTICS_EVENTS.PROFILE_VIEWED,
  ANALYTICS_EVENTS.SETTINGS_CHANGED,
  ANALYTICS_EVENTS.NOTIFICATION_PERMISSION_GRANTED,
  ANALYTICS_EVENTS.NOTIFICATION_PERMISSION_DENIED,
  ANALYTICS_EVENTS.ERROR_SHOWN,
  ANALYTICS_EVENTS.PERFORMANCE_METRIC_REPORTED,
  ANALYTICS_EVENTS.FEATURE_FLAG_EXPOSED,
  ANALYTICS_EVENTS.BUFFER_OVERFLOWED,
  ANALYTICS_EVENTS.DAILY_SHARED,
]);

/**
 * Build the analytics event-track router.
 *
 * @returns Express router mounted at `/api/events`.
 */
export function createEventsRouter(): Router {
  const router = Router();

  // Per-IP rate limit — prevents a runaway tab from flooding ingest. The
  // visitor_id dimension would be more correct but IP is simpler and
  // deliberate: a single device in an enterprise NAT still maps to one IP,
  // and legitimate traffic (120 events / 60 s) has plenty of headroom.
  const beaconLimiter = rateLimit({
    windowMs: config.eventTrackRateWindowMs,
    max: config.eventTrackRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many events" },
  });

  router.post("/track", beaconLimiter, (req: Request, res: Response) => {
    try {
      const envelope = validateEnvelope(req.body);
      if (!envelope) {
        res.status(400).json({ error: "invalid envelope" });
        return;
      }

      let accepted = 0;
      for (const ev of envelope.events) {
        // Reject any event whose name is not on the client allowlist — server
        // hooks own game/auth/MP lifecycle and must not be overridable by
        // client-supplied payloads.
        if (!CLIENT_EVENT_ALLOWLIST.has(ev.name)) continue;
        const sessionId = recordEventFromRequest(req, {
          eventName: ev.name,
          eventType: ev.category ?? "custom",
          tsClient: ev.ts,
          path: ev.path,
          properties: ev.properties ?? null,
          tabId: envelope.tabId,
          seq: ev.seq,
          clientEventId: ev.clientEventId,
        });
        if (sessionId) accepted++;
      }

      res.status(204).end();
      // accepted is logged server-side only; clients don't need the count
      // (the beacon is fire-and-forget and may not even read the response).
      void accepted;
    } catch (err) {
      console.error("events/track failed:", err);
      res.status(204).end();
    }
  });

  return router;
}

/**
 * Validate and clamp a client beacon envelope. Drops events that exceed the
 * batch cap, reject payloads that don't match the shape, and never throws.
 */
function validateEnvelope(body: unknown): BeaconEnvelope | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const tabId = typeof b.tabId === "string" ? b.tabId.slice(0, 64) : null;
  const sentAt = typeof b.sentAt === "number" ? b.sentAt : null;
  const eventsRaw = Array.isArray(b.events) ? b.events : null;
  if (!tabId || sentAt == null || !eventsRaw) return null;

  const events: BeaconEnvelope["events"] = [];
  for (const rawEv of eventsRaw.slice(0, BEACON_MAX_EVENTS)) {
    if (!rawEv || typeof rawEv !== "object") continue;
    const ev = rawEv as Record<string, unknown>;
    const name = typeof ev.name === "string" ? ev.name.slice(0, 64) : null;
    const path = typeof ev.path === "string" ? ev.path.slice(0, 512) : null;
    const ts = typeof ev.ts === "number" ? ev.ts : null;
    const seq = typeof ev.seq === "number" ? ev.seq : null;
    const clientEventId =
      typeof ev.clientEventId === "string" ? ev.clientEventId.slice(0, 64) : null;

    if (!name || !path || ts == null || seq == null || !clientEventId) continue;

    const category = typeof ev.category === "string" ? ev.category : undefined;
    const properties =
      ev.properties && typeof ev.properties === "object" && !Array.isArray(ev.properties)
        ? (ev.properties as Record<string, string | number | boolean | null>)
        : undefined;

    events.push({
      name,
      category: category as BeaconEnvelope["events"][number]["category"],
      properties,
      path,
      ts,
      seq,
      clientEventId,
    });
  }

  if (events.length === 0) return null;
  return { tabId, sentAt, events };
}
