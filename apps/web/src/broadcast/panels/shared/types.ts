/**
 * Shared types for the NN broadcast panels.
 *
 * Each panel takes the latest VisualTick (or null when none has
 * arrived yet) plus a phase signal that drives its phase-aware
 * choreography (idle / thinking / guessing / reveal / result).
 *
 * The `?panels=` query string toggles which panels mount; per-panel
 * mount is decided in BroadcastShell, so panel components themselves
 * never need to know about the query — they just render against the
 * tick they're handed.
 */

import type { NnTick } from "../../state/overlayBus";

/** Bag of inputs every NN panel consumes. */
export interface NnPanelProps {
  tick: NnTick | null;
}

/** Known panel keys. The `?panels=` parser uses this list. */
export const ALL_NN_PANELS = ["mlp", "gauge", "dots", "debug"] as const;
export type NnPanelKey = (typeof ALL_NN_PANELS)[number];

/**
 * Parse the `?panels=` query string into a Set of enabled panels.
 * Defaults to "all on" when the param is absent. Unknown tokens
 * are dropped silently.
 *
 * @param raw The raw query-string value (e.g. "mlp,gauge").
 */
export function parsePanelsQuery(raw: string | null | undefined): Set<NnPanelKey> {
  if (!raw) return new Set(ALL_NN_PANELS);
  const tokens = raw.split(",").map((t) => t.trim().toLowerCase());
  const out = new Set<NnPanelKey>();
  for (const t of tokens) {
    if ((ALL_NN_PANELS as readonly string[]).includes(t)) {
      out.add(t as NnPanelKey);
    }
  }
  // Empty result (caller passed "?panels=") → fallback to all-on.
  // Without this, a typo in the query would silently hide every panel.
  if (out.size === 0) return new Set(ALL_NN_PANELS);
  return out;
}
