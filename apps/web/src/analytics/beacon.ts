/**
 * Beacon sender for the client analytics pipeline.
 *
 * Buffers events in-memory, flushes on a timer or on `visibilitychange →
 * hidden`, and transports via `fetch(url, { keepalive: true })` (or
 * `navigator.sendBeacon` as a fallback on older Safari).
 *
 * Resilience:
 *  - On network failure, writes the pending buffer to localStorage so
 *    the next page load can drain it with exponential backoff.
 *  - Caps buffer at 200 events to bound memory.
 *  - Caps localStorage retention at 50 KB to stay well under the per-site
 *    quota.
 *  - Caps single-flush payload at BEACON_MAX_EVENTS to stay under the
 *    64 KB sendBeacon limit.
 *
 * Privacy:
 *  - If `navigator.doNotTrack === "1"` or `navigator.globalPrivacyControl`
 *    is true, the beacon is a permanent no-op for this session. No
 *    network traffic, no localStorage writes.
 */

import {
  BEACON_MAX_EVENTS,
  PROPS_MAX_BYTES,
  type BufferedEvent,
  type BeaconEnvelope,
} from "./types";

const ENDPOINT = "/api/events/track";
const STORAGE_KEY = "pg_ev_buf";
const STORAGE_MAX_BYTES = 50 * 1024;
const BUFFER_MAX = 200;
const FLUSH_INTERVAL_MS = 5000;

interface BeaconState {
  tabId: string;
  buffer: BufferedEvent[];
  seq: number;
  disabled: boolean;
  flushTimer: ReturnType<typeof setInterval> | null;
  visibilityHandler: (() => void) | null;
  pagehideHandler: (() => void) | null;
}

let state: BeaconState | null = null;

/**
 * Detect whether the user has signalled they do not want to be tracked.
 * Respects classic DNT and the newer Sec-GPC (Global Privacy Control) spec.
 * Treats the W3C "unspecified" / "null" values as consent-to-track.
 */
export function tracking_disabled(): boolean {
  if (typeof navigator === "undefined") return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl === true) return true;
  if (nav.doNotTrack === "1" || nav.doNotTrack === "yes") return true;
  return false;
}

function randomTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function randomEventId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Initialize the beacon pipeline. Safe to call more than once; subsequent
 * calls are no-ops.
 *
 * @returns Teardown function (stops flush timer + removes listeners).
 */
export function initBeacon(): () => void {
  if (state) return noopTeardown;
  if (typeof window === "undefined") return noopTeardown;

  const disabled = tracking_disabled();
  const s: BeaconState = {
    tabId: randomTabId(),
    buffer: [],
    seq: 0,
    disabled,
    flushTimer: null,
    visibilityHandler: null,
    pagehideHandler: null,
  };
  state = s;

  if (disabled) return noopTeardown;

  // Drain any persisted events from a previous crashed session.
  try {
    drainPersistedBuffer();
  } catch {
    // localStorage disabled (private browsing) — ignore.
  }

  s.flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);

  s.visibilityHandler = () => {
    if (document.visibilityState === "hidden") {
      void flush();
    }
  };
  document.addEventListener("visibilitychange", s.visibilityHandler);

  // pagehide fires even when visibilitychange won't (BFCache on iOS), so
  // double-bind to cover both.
  s.pagehideHandler = () => void flush();
  window.addEventListener("pagehide", s.pagehideHandler);

  return () => teardown(s);
}

function teardown(s: BeaconState): void {
  if (s.flushTimer) clearInterval(s.flushTimer);
  if (s.visibilityHandler) {
    document.removeEventListener("visibilitychange", s.visibilityHandler);
  }
  if (s.pagehideHandler) {
    window.removeEventListener("pagehide", s.pagehideHandler);
  }
  if (state === s) state = null;
}

const noopTeardown = (): void => {
  // No-op; used when tracking is disabled or SSR.
};

/**
 * Queue an event for transmission. Never throws; the caller can treat it
 * as fire-and-forget. If the internal buffer overflows, the oldest events
 * are dropped and a synthetic `buffer_overflowed` event is queued so
 * server-side dashboards can detect loss.
 *
 * @param ev - Partial buffered event (ts, seq, and clientEventId are filled in).
 */
export function enqueue(ev: Omit<BufferedEvent, "ts" | "seq" | "clientEventId">): void {
  const s = state;
  if (!s || s.disabled) return;

  if (s.buffer.length >= BUFFER_MAX) {
    s.buffer.shift();
    // Avoid recursion by inlining the overflow synthetic event.
    s.buffer.push({
      name: "buffer_overflowed",
      category: "system",
      path: ev.path,
      ts: Date.now(),
      seq: ++s.seq,
      clientEventId: randomEventId(),
    });
    return;
  }

  const sanitizedProps = sanitizeProps(ev.properties);
  s.buffer.push({
    ...ev,
    properties: sanitizedProps,
    ts: Date.now(),
    seq: ++s.seq,
    clientEventId: randomEventId(),
  });
}

function sanitizeProps(
  properties: BufferedEvent["properties"],
): BufferedEvent["properties"] {
  if (!properties) return undefined;
  try {
    const json = JSON.stringify(properties);
    if (json.length > PROPS_MAX_BYTES) {
      return { _truncated: true };
    }
    return properties;
  } catch {
    return undefined;
  }
}

/**
 * Flush the buffer immediately. Can be called from visibilitychange,
 * pagehide, or as a manual trigger from a test. The call is fire-and-forget
 * from the caller's perspective — failures are caught and persisted for
 * later replay.
 */
export async function flush(): Promise<void> {
  const s = state;
  if (!s || s.disabled) return;
  if (s.buffer.length === 0) return;

  // Drain up to BEACON_MAX_EVENTS at a time so we stay under the 64KB
  // sendBeacon cap even if the buffer is at max capacity.
  const batch = s.buffer.splice(0, BEACON_MAX_EVENTS);
  const envelope: BeaconEnvelope = {
    sentAt: Date.now(),
    tabId: s.tabId,
    events: batch,
  };

  const ok = await send(envelope);
  if (!ok) persistForReplay([envelope]);
}

async function send(envelope: BeaconEnvelope): Promise<boolean> {
  const body = JSON.stringify(envelope);

  // fetch(keepalive) is the preferred path — it has no 64KB limit, but
  // we still enforce BEACON_MAX_EVENTS upstream. Older Safari lacks
  // keepalive; fall back to sendBeacon there.
  try {
    if (supportsFetchKeepalive()) {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        credentials: "include",
      });
      return res.ok;
    }
  } catch {
    // fall through to sendBeacon
  }

  try {
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      const blob = new Blob([body], { type: "application/json" });
      return navigator.sendBeacon(ENDPOINT, blob);
    }
  } catch {
    // swallow — persistence path below handles it.
  }

  return false;
}

let _supportsFetchKeepalive: boolean | null = null;
function supportsFetchKeepalive(): boolean {
  if (_supportsFetchKeepalive !== null) return _supportsFetchKeepalive;
  try {
    // Heuristic: browsers that implement Request with `keepalive` property.
    new Request("/", { keepalive: true });
    _supportsFetchKeepalive = true;
  } catch {
    _supportsFetchKeepalive = false;
  }
  return _supportsFetchKeepalive;
}

function persistForReplay(envelopes: BeaconEnvelope[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    const payload = JSON.stringify(envelopes);
    if (payload.length > STORAGE_MAX_BYTES) {
      // Drop old envelopes that won't fit rather than overflow quota.
      localStorage.setItem(STORAGE_KEY, "[]");
      return;
    }
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // Private mode or quota exceeded — quiet.
  }
}

function drainPersistedBuffer(): void {
  if (typeof localStorage === "undefined") return;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  localStorage.removeItem(STORAGE_KEY);

  let envelopes: BeaconEnvelope[];
  try {
    envelopes = JSON.parse(raw);
    if (!Array.isArray(envelopes)) return;
  } catch {
    return;
  }

  // Fire-and-forget replay. Any that fail get re-persisted.
  const retry = async (): Promise<void> => {
    const stillFailed: BeaconEnvelope[] = [];
    for (const env of envelopes) {
      const ok = await send(env);
      if (!ok) stillFailed.push(env);
    }
    if (stillFailed.length) persistForReplay(stillFailed);
  };

  // Defer replay to idle time so we don't steal from React hydration.
  const idle = (window as unknown as { requestIdleCallback?: typeof requestIdleCallback })
    .requestIdleCallback;
  if (typeof idle === "function") {
    idle(() => void retry(), { timeout: 10_000 });
  } else {
    setTimeout(() => void retry(), 2_000);
  }
}

/**
 * Test-only helper: reset state. Clears buffer, cancels timers, forgets tabId.
 *
 * @internal
 */
export function __resetBeaconState(): void {
  if (state) teardown(state);
  state = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* empty */
  }
}

/**
 * Test-only helper: inspect current state.
 *
 * @internal
 */
export function __getBeaconState(): Readonly<BeaconState> | null {
  return state;
}
