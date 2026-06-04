/**
 * Music source — bridges the in-container `mpd` daemon to the broadcast
 * overlay's `music.now` event AND the runner's `nowPlaying` command
 * state (so `!song` reports the right thing).
 *
 * Wire shape:
 *   1. `mpc current -f "%title%\t%artist%\t%album%\t%file%"` once on
 *      start to surface a track that's already playing. The separator
 *      is a literal tab — `|` cannot be used because mpc's format
 *      parser treats `|` as a conditional-fallback operator, so
 *      `%title%|%artist%` evaluates to "title if title is non-empty,
 *      else artist" and the multi-field intent is lost. Tab is safe
 *      because no song metadata contains a literal tab character.
 *   2. Self-bootstrap: if `mpc status` reports stopped AND the database
 *      has files, run `mpc add /` then `mpc play`. mpd doesn't auto-
 *      enqueue from `music_directory`; without this the daemon runs
 *      with an empty queue and the overlay shows nothing.
 *   3. `mpc idleloop player` blocks until mpd's player state changes,
 *      then prints `player` on stdout. We re-read `mpc current` and
 *      emit when the file path changes.
 *
 * mpd-not-running (entrypoint.sh skips mpd when the music dir is empty)
 * surfaces as exit-1 with "Connection refused" on the first `mpc`
 * call. In that case we log + give up — the overlay's idle placeholder
 * stays.
 */
import type { ChildProcess, SpawnOptions } from "child_process";
import { spawn as nodeSpawn } from "child_process";
import type { OverlayForwarder } from "./overlay";

/** Subset of `child_process.spawn` we actually use; injectable for tests. */
export type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnOptions,
) => ChildProcess;

export interface MusicSourceDeps {
  overlay: OverlayForwarder;
  /** Default `child_process.spawn`; tests inject a fake. */
  spawn?: SpawnLike;
  /**
   * Optional command-state target. If supplied, we keep
   * `commandState.nowPlaying` in sync so `!song` reports the right
   * track name.
   */
  commandState?: { nowPlaying: string | null };
  /** Called with non-fatal warnings (logged at INFO, not error). */
  onWarning?: (msg: string) => void;
  /** Called with fatal errors (after which the source has stopped). */
  onError?: (err: Error) => void;
  /**
   * Called with lifecycle / progress messages (start, mpd reachable,
   * track emitted, running summary). Wired by the runner to the
   * structured telemetry sink so the events end up in the same JSON-
   * line stream as the rest of the bot's observability data. Default
   * is a no-op so unit tests don't need to provide one.
   */
  onInfo?: (msg: string) => void;
  /** Sleep used by the idleloop respawn backoff; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Idleloop respawn backoff in ms (default 2000). */
  respawnBackoffMs?: number;
  /**
   * Maximum number of idleloop spawn attempts INCLUDING the initial
   * spawn (default 3). After this many spawns have all exited the
   * source gives up via `onError`. Named `…Attempts` not `…Respawns`
   * so the count of total spawns is unambiguous.
   */
  maxIdleloopAttempts?: number;
  /**
   * Maximum number of mpd-bootstrap attempts INCLUDING the initial
   * one. The bootstrap loop retries with exponential backoff (5s,
   * 15s, 30s, 60s, 120s, 300s) so a streamer container that boots
   * before mpd's music dir is populated still picks up music once
   * the operator drops files in. After this cap is reached the
   * source gives up via `onError`. Defaults to `Infinity` (retry
   * forever in production); tests inject small values to keep the
   * suite fast.
   */
  maxBootstrapAttempts?: number;
  /**
   * Optional server-relay config. When both fields are set, every
   * track change is mirrored to `${targetUrl}/api/streamer/music`
   * (auth: `X-Streamer-Bot: <secret>`) so the server can fan the
   * track out via Socket.IO to any `?broadcast=1` viewer — not just
   * the bot's own Chromium tab. When either field is unset the
   * source falls back to local-postMessage-only (legacy behaviour).
   */
  serverRelay?: {
    targetUrl: string;
    streamerBotSecret: string;
    /** Injectable for tests; defaults to globalThis.fetch. */
    fetchImpl?: typeof fetch;
  };
  /**
   * Heartbeat interval in ms. Every tick re-POSTs the most recently
   * known track to the server relay so the server cache stays warm
   * across (a) server restarts that wipe its in-memory cache, (b)
   * a single dropped POST mid-flight, and (c) any other transient
   * loss. The local `overlay.send` is NOT re-emitted on heartbeat —
   * it's already in the bot's own bus and re-emitting would just
   * thrash the reducer.
   *
   * Default 30_000ms. Set to 0 to disable. The first heartbeat
   * fires `heartbeatIntervalMs` after the source starts, not
   * immediately — there's no benefit to re-asserting before the
   * idleloop has had a chance to publish the current track at all.
   *
   * Heartbeat is a no-op when `serverRelay` is unset (no destination)
   * or no track has been seen yet (no payload to re-assert).
   */
  heartbeatIntervalMs?: number;
  /**
   * Injectable timer for tests. Defaults to `setInterval` /
   * `clearInterval`. Tests can stub these to drive heartbeats
   * synchronously without burning real wall-clock time.
   */
  setIntervalImpl?: (handler: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}

export interface MusicSource {
  stop(): void;
}

interface ParsedTrack {
  title: string;
  artist?: string;
  album?: string;
  file: string;
}

/** Field separator passed to `mpc current -f …`. Tab is used because
 *  mpc treats `|` as a conditional-fallback operator (so the obvious
 *  `%title%|%artist%|…` collapses to just whichever field is non-empty
 *  first). No song metadata contains a literal tab. Exposed for the
 *  test harness so it can build mpc-shaped fixture lines. */
const MPC_FIELD_SEP = "\t";
const MPC_CURRENT_FORMAT =
  `%title%${MPC_FIELD_SEP}%artist%${MPC_FIELD_SEP}%album%${MPC_FIELD_SEP}%file%`;

function parseCurrent(raw: string): ParsedTrack | null {
  // Split on LF / CRLF and take the first non-empty line. We
  // intentionally do NOT `.trim()` each line — the field separator
  // is a tab, and `String.prototype.trim` strips tabs along with
  // spaces, which silently drops a leading/trailing empty field.
  // The empty-title case (`\tArtist\tAlbum\tfile.mp3`) would
  // otherwise come back with only three parts and parse as null,
  // exactly the case the filename-fallback below is meant to
  // handle. The CRLF-aware regex split absorbs Windows-style
  // line endings without re-introducing trim.
  const line = raw.split(/\r?\n/).find((s) => s.length > 0);
  if (!line) return null;
  const parts = line.split(MPC_FIELD_SEP);
  if (parts.length < 4) return null;
  const [title, artist, album, file] = parts;
  if (!file) return null;
  return {
    title: title || (file.split("/").pop() ?? "Unknown"),
    artist: artist || undefined,
    album: album || undefined,
    file,
  };
}

/**
 * Run `mpc <args>` to completion, returning stdout. Rejects on a non-
 * zero exit so callers can treat "Connection refused" as a fatal start
 * condition.
 */
function runMpc(spawnFn: SpawnLike, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnFn("mpc", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`mpc ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

export function createMusicSource(deps: MusicSourceDeps): MusicSource {
  const spawnFn = deps.spawn ?? (nodeSpawn as SpawnLike);
  const onWarning = deps.onWarning ?? ((m) => { console.warn(`[music] ${m}`); });
  const onError = deps.onError ?? ((e) => { console.warn(`[music] ${e.message}`); });
  const onInfo = deps.onInfo ?? (() => { /* default: silent */ });
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const respawnBackoffMs = deps.respawnBackoffMs ?? 2000;
  const maxIdleloopAttempts = deps.maxIdleloopAttempts ?? 3;
  const maxBootstrapAttempts = deps.maxBootstrapAttempts ?? Number.POSITIVE_INFINITY;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 30_000;
  const setIntervalFn = deps.setIntervalImpl
    ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const clearIntervalFn = deps.clearIntervalImpl
    ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  let stopped = false;
  let lastFile: string | null = null;
  // Track the last successfully built payload so the heartbeat can
  // re-assert it without re-running mpc. `lastFile` is just for
  // change detection; the heartbeat needs the full payload shape.
  let lastPayload: { title: string; artist?: string; album?: string } | null = null;
  let idleloop: ChildProcess | null = null;
  let heartbeatHandle: unknown = null;
  // Caps the server-relay POST work so a slow / unhealthy server
  // can't snowball into an unbounded queue of in-flight requests
  // when mpd flaps OR the heartbeat overlaps with a track change.
  // One in-flight at a time + 5s timeout. Track changes that arrive
  // while a POST is in-flight are dropped — the next track change
  // emits a fresh POST with the latest payload, so the only cost is
  // one missed update under flap. Heartbeats that overlap an
  // in-flight POST are dropped too, since the in-flight request
  // already represents the latest state.
  let relayInFlight = false;
  const RELAY_TIMEOUT_MS = 5_000;

  /**
   * Fire-and-forget POST of a track payload to the server relay.
   * Honours the in-flight cap so a slow server can't pile requests.
   * No-op when relay creds aren't configured (dev / tests) or no
   * fetch implementation is available.
   *
   * Both network errors and non-2xx responses are surfaced via
   * `onWarning` — silently swallowing them was the chief reason
   * past music outages went undiagnosed for so long. The cost of
   * one warn line per failed POST is trivial; the ability to
   * `docker logs streamer | grep music.relay` is invaluable.
   */
  function postToRelay(payload: { title: string; artist?: string; album?: string }): void {
    if (!deps.serverRelay || relayInFlight) return;
    const relay = deps.serverRelay;
    const fetchImpl = relay.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!fetchImpl) {
      onWarning("music.relay: no fetch implementation available; POST skipped");
      return;
    }
    relayInFlight = true;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RELAY_TIMEOUT_MS);
    void (async () => {
      try {
        const res = await fetchImpl(`${relay.targetUrl}/api/streamer/music`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-streamer-bot": relay.streamerBotSecret,
          },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
        if (!res.ok) {
          // Read a small slice of the body to help diagnose 4xx
          // (likely "invalid_payload" from the server's parser).
          let snippet = "";
          try {
            snippet = (await res.text()).slice(0, 200);
          } catch { /* ignore */ }
          onWarning(`music.relay: POST returned ${res.status} ${res.statusText} body=${snippet}`);
        }
      } catch (err) {
        onWarning(`music.relay: POST failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
        relayInFlight = false;
      }
    })();
  }

  async function emitCurrent(): Promise<void> {
    let raw: string;
    try {
      raw = await runMpc(spawnFn, ["current", "-f", MPC_CURRENT_FORMAT]);
    } catch (err) {
      onWarning(`mpc current failed: ${(err as Error).message}`);
      return;
    }
    const track = parseCurrent(raw);
    if (!track) {
      // Queue is stopped/empty — not an error, just nothing to emit.
      return;
    }
    if (track.file === lastFile) return;
    lastFile = track.file;
    const payload = { title: track.title, artist: track.artist, album: track.album };
    lastPayload = payload;
    onInfo(`emit ${JSON.stringify(payload)}`);
    void deps.overlay.send("music.now", payload);
    // Server relay — best-effort, never blocks. Reaches every
    // `?broadcast=1` viewer (not just the bot's own Chromium tab).
    postToRelay(payload);
    if (deps.commandState) {
      deps.commandState.nowPlaying = track.artist
        ? `${track.title} by ${track.artist}`
        : track.title;
    }
  }

  /**
   * Periodically re-assert the last-known track to the server
   * relay. The cache on the server is in-memory: a server restart
   * (deploy, OOM, container kill) wipes it, and without a heartbeat
   * the broadcast panel stays empty until the next mpd track change
   * — typically minutes later. The heartbeat closes that window to
   * `heartbeatIntervalMs` regardless of how often mpd actually
   * advances tracks.
   *
   * No-op when:
   *  - heartbeatIntervalMs is 0 (operator opt-out / tests)
   *  - serverRelay is unset (nothing to POST to)
   *  - lastPayload is null (no track ever published — heartbeating
   *    a null doesn't help; the regular track-change path will
   *    take over once mpd starts emitting)
   *  - relayInFlight is true (the existing POST already represents
   *    fresh state)
   */
  function startHeartbeat(): void {
    if (heartbeatIntervalMs <= 0) return;
    if (!deps.serverRelay) return;
    heartbeatHandle = setIntervalFn(() => {
      if (stopped || !lastPayload) return;
      postToRelay(lastPayload);
    }, heartbeatIntervalMs);
  }

  async function bootstrapQueueIfStopped(): Promise<void> {
    // First mpc call — if this rejects, mpd is unreachable. The
    // promise propagates up to the bootstrap kickoff which routes
    // through onError so the source gives up cleanly.
    const status = await runMpc(spawnFn, ["status"]);
    if (/\[playing\]/.test(status)) return;
    // Either [paused] or [stopped]. The streamer is a 24/7 broadcast
    // — there's no "operator wanted it paused" case worth honouring,
    // so always nudge mpd back into [playing]. The mpd `state_file`
    // can preserve [paused] across container restarts, so this also
    // covers the case where a previous container was stopped mid-
    // playback.
    let needsAdd = false;
    if (/\[stopped\]|\bplaying:\s*0\/0/.test(status)) {
      // Truly stopped, possibly empty. Only enqueue if the playlist
      // really is empty — operator-cleared queues should not be
      // re-flooded with the entire library on every container
      // restart.
      try {
        const playlist = await runMpc(spawnFn, ["playlist"]);
        needsAdd = playlist.trim().length === 0;
      } catch (err) {
        onWarning(`mpc playlist probe failed; assuming empty: ${(err as Error).message}`);
        needsAdd = true;
      }
    }
    try {
      if (needsAdd) await runMpc(spawnFn, ["add", "/"]);
      await runMpc(spawnFn, ["play"]);
    } catch (err) {
      onWarning(`mpc enqueue/play failed: ${(err as Error).message}`);
    }
  }

  function startIdleLoop(attempt: number): void {
    if (stopped) return;
    const child = spawnFn("mpc", ["idleloop", "player"], { stdio: ["ignore", "pipe", "pipe"] });
    idleloop = child;
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === "player") {
          void emitCurrent();
        }
      }
    });
    const handleExit = (): void => {
      if (stopped) return;
      idleloop = null;
      if (attempt + 1 >= maxIdleloopAttempts) {
        onError(new Error(`mpc idleloop exited ${maxIdleloopAttempts} times; music updates stop`));
        return;
      }
      void sleep(respawnBackoffMs).then(() => {
        if (!stopped) startIdleLoop(attempt + 1);
      });
    };
    child.on("exit", handleExit);
    child.on("error", (err) => {
      onWarning(`mpc idleloop spawn error: ${err.message}`);
      handleExit();
    });
  }

  // Bootstrap kickoff with retry. The original implementation gave
  // up forever after the first `mpc status` failure — which meant
  // any container where mpd hadn't finished starting (or where mpd
  // was added to the music dir AFTER the bot booted) would never
  // publish a track until the container was restarted. The retry
  // loop walks an exponential backoff capped at 5 minutes, re-
  // attempting bootstrap until it succeeds or `stop()` is called.
  // Each attempt logs its outcome so an operator running
  // `docker logs streamer | grep music` can see exactly where the
  // pipeline is stuck.
  const BOOTSTRAP_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  function bootstrapBackoffFor(attempt: number): number {
    return BOOTSTRAP_BACKOFF_MS[Math.min(attempt, BOOTSTRAP_BACKOFF_MS.length - 1)];
  }
  void (async () => {
    let attempt = 0;
    onInfo("starting; mpd bootstrap loop begins");
    while (!stopped) {
      try {
        await bootstrapQueueIfStopped();
      } catch (err) {
        attempt += 1;
        if (attempt >= maxBootstrapAttempts) {
          onError(new Error(
            `bootstrap exhausted after ${attempt} attempts; last error: ${(err as Error).message}`,
          ));
          return;
        }
        const wait = bootstrapBackoffFor(attempt - 1);
        onWarning(
          `bootstrap attempt ${attempt} failed (${(err as Error).message}); `
          + `retrying in ${Math.round(wait / 1000)}s`,
        );
        await sleep(wait);
        continue;
      }
      onInfo(`mpd reachable after ${attempt + 1} attempt(s); priming current track + idleloop`);
      break;
    }
    if (stopped) return;
    await emitCurrent();
    if (stopped) return;
    startIdleLoop(0);
    // Heartbeat is started AFTER the initial emit + idleloop attach
    // so we never re-POST a stale value before the first real probe
    // has had a chance to update lastPayload.
    startHeartbeat();
    onInfo(
      `running (heartbeat ${heartbeatIntervalMs}ms, `
      + `relay=${deps.serverRelay ? "on" : "off"}, `
      + `lastPayload=${lastPayload ? JSON.stringify(lastPayload) : "null"})`,
    );
  })();

  return {
    stop() {
      stopped = true;
      if (idleloop) {
        try { idleloop.kill(); } catch { /* best effort */ }
        idleloop = null;
      }
      if (heartbeatHandle !== null) {
        try { clearIntervalFn(heartbeatHandle); } catch { /* best effort */ }
        heartbeatHandle = null;
      }
    },
  };
}

export const __musicSourceInternals = { parseCurrent, MPC_FIELD_SEP, MPC_CURRENT_FORMAT };
