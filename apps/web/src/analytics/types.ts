/**
 * Client-side analytics types. Re-exports shared taxonomy so consumers
 * import from a single module within apps/web.
 */

export type {
  AnalyticsEventCategory,
  AnalyticsEventName,
  TrackPayload,
  BeaconEnvelope,
} from "@price-game/shared";

export { ANALYTICS_EVENTS, PROPS_MAX_BYTES, BEACON_MAX_EVENTS } from "@price-game/shared";

/** Internal buffered event shape — adds client-generated fields. */
export interface BufferedEvent {
  name: string;
  category?: "page" | "game" | "auth" | "mp" | "system" | "custom";
  properties?: Record<string, string | number | boolean | null>;
  path: string;
  ts: number;
  seq: number;
  clientEventId: string;
}
