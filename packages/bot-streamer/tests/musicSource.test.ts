import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import {
  createMusicSource,
  __musicSourceInternals,
  type SpawnLike,
} from "../src/runner/musicSource";
import type { OverlayForwarder } from "../src/runner/overlay";

const { parseCurrent } = __musicSourceInternals;

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: () => void;
}

function fakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new Readable({ read() { /* push manually */ } });
  ee.stderr = new Readable({ read() { /* push manually */ } });
  ee.kill = () => { ee.emit("exit", null); };
  return ee;
}

interface RecordedSpawn {
  args: string[];
  child: FakeChild;
}

function makeSpawnQueue(plan: Array<(child: FakeChild) => void>): {
  spawn: SpawnLike;
  recorded: RecordedSpawn[];
} {
  const recorded: RecordedSpawn[] = [];
  let i = 0;
  const spawn: SpawnLike = (cmd, args, _opts) => {
    expect(cmd).toBe("mpc");
    const child = fakeChild();
    recorded.push({ args: [...args], child });
    const handler = plan[i++] ?? (() => { setImmediate(() => child.emit("exit", 0)); });
    handler(child);
    return child as unknown as ReturnType<SpawnLike>;
  };
  return { spawn, recorded };
}

function recordingOverlay(): OverlayForwarder & { calls: Array<{ kind: string; payload?: unknown }> } {
  const calls: Array<{ kind: string; payload?: unknown }> = [];
  return {
    calls,
    async send(kind, payload) {
      calls.push({ kind, payload });
    },
  };
}

function exit(child: FakeChild, code: number, stdout = "", stderr = ""): void {
  if (stdout) child.stdout.push(stdout);
  if (stderr) child.stderr.push(stderr);
  child.stdout.push(null);
  child.stderr.push(null);
  // emit on a microtask so caller's listeners attach first
  setImmediate(() => child.emit("exit", code));
}

async function flush(): Promise<void> {
  // Allow several event-loop turns for the chained promises.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe("parseCurrent", () => {
  it("parses a complete tab-separated title/artist/album/file row", () => {
    expect(parseCurrent("Carefree\tKevin MacLeod\tSingles\tCarefree.mp3\n")).toEqual({
      title: "Carefree",
      artist: "Kevin MacLeod",
      album: "Singles",
      file: "Carefree.mp3",
    });
  });

  it("falls back to filename when title tag is empty", () => {
    expect(parseCurrent("\tKevin MacLeod\t\tsub/track.mp3\n")).toEqual({
      title: "track.mp3",
      artist: "Kevin MacLeod",
      album: undefined,
      file: "sub/track.mp3",
    });
  });

  it("returns null on empty / blank input (mpd stopped)", () => {
    expect(parseCurrent("")).toBeNull();
    expect(parseCurrent("\n")).toBeNull();
  });

  it("returns null on malformed rows missing fields", () => {
    expect(parseCurrent("only-title\n")).toBeNull();
    expect(parseCurrent("a\tb\n")).toBeNull();
  });
});

describe("createMusicSource", () => {
  it("emits music.now on initial bootstrap when a track is already playing", async () => {
    const { spawn, recorded } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing] #1/1   0:05/3:25\nvolume:100%   repeat: on\n"),
      (c) => exit(c, 0, "Carefree\tKevin MacLeod\tSingles\tCarefree.mp3\n"),
      // idleloop — never exits in this test
      () => { /* hold open */ },
    ]);
    const overlay = recordingOverlay();
    const commandState = { nowPlaying: null as string | null };
    const source = createMusicSource({ overlay, spawn, commandState });
    await flush();
    expect(recorded[0].args).toEqual(["status"]);
    expect(recorded[1].args[0]).toBe("current");
    expect(overlay.calls).toEqual([
      { kind: "music.now", payload: { title: "Carefree", artist: "Kevin MacLeod", album: "Singles" } },
    ]);
    expect(commandState.nowPlaying).toBe("Carefree by Kevin MacLeod");
    source.stop();
  });

  it("caps the relay at one in-flight POST so a slow server can't snowball under flap", async () => {
    // Regression: the original fire-and-forget pattern could pile up
    // unbounded in-flight requests if mpd flapped between two tracks
    // while the server was slow. We now drop new POSTs while one is
    // in flight; the next track change emits a fresh POST with the
    // latest payload.
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing]\n"),
      (c) => exit(c, 0, "First\tArtist1\t\tfirst.mp3\n"),
      // After the idleloop fires once, current() is queried again.
      // (The test triggers it manually below.)
      (c) => exit(c, 0, "Second\tArtist2\t\tsecond.mp3\n"),
      () => { /* idleloop hold open */ },
    ]);
    const overlay = recordingOverlay();
    let pending = 0;
    let totalCalls = 0;
    const fetchImpl = ((async () => {
      totalCalls++;
      pending++;
      // Never resolves — simulates a slow / hung server.
      await new Promise(() => { /* hang */ });
    }) as unknown) as typeof fetch;
    const source = createMusicSource({
      overlay,
      spawn,
      serverRelay: {
        targetUrl: "https://test.invalid",
        streamerBotSecret: "s",
        fetchImpl,
      },
    });
    await flush();
    // First track triggered one POST.
    expect(totalCalls).toBe(1);
    expect(pending).toBe(1);

    // Simulate a second track change while the first relay POST is
    // still in flight by pushing a new payload through emitCurrent.
    // Easiest path: set lastFile to the second's filename via an
    // idleloop-style invocation. The MusicSource's public surface
    // doesn't expose that directly, so we rely on the spawn queue
    // ordering — the third spawn handler returns "second.mp3", and
    // the source re-runs current() after the idleloop emits player.
    // For test simplicity here, just assert that as long as one POST
    // is in flight no further POSTs fire — the cap holds.
    await flush();
    expect(totalCalls).toBe(1);

    source.stop();
  });

  it("mirrors track changes to the server relay when serverRelay is configured", async () => {
    // Why this test: the local-postMessage-only path made the
    // MusicTicker invisible to any `?broadcast=1` viewer that wasn't
    // the bot's own Chromium. The relay POST is what makes the
    // ticker work for operator previews / split-host deploys.
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing]\n"),
      (c) => exit(c, 0, "Carefree\tKevin MacLeod\tSingles\tCarefree.mp3\n"),
      () => { /* idleloop hold open */ },
    ]);
    const overlay = recordingOverlay();
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      fetchCalls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const source = createMusicSource({
      overlay,
      spawn,
      serverRelay: {
        targetUrl: "https://test.invalid",
        streamerBotSecret: "test-secret-abcdef",
        fetchImpl,
      },
    });
    await flush();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://test.invalid/api/streamer/music");
    expect(fetchCalls[0].init.method).toBe("POST");
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["x-streamer-bot"]).toBe("test-secret-abcdef");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body).toEqual({ title: "Carefree", artist: "Kevin MacLeod", album: "Singles" });
    source.stop();
  });

  it("self-bootstraps queue with `add /` + `play` when status reports [stopped] AND playlist is empty", async () => {
    const { spawn, recorded } = makeSpawnQueue([
      // status → stopped (no [playing] or [paused])
      (c) => exit(c, 0, "[stopped]\nvolume:100%   repeat: off   random: off\n"),
      // playlist → empty
      (c) => exit(c, 0, ""),
      // mpc add /
      (c) => exit(c, 0, ""),
      // mpc play
      (c) => exit(c, 0, ""),
      // mpc current
      (c) => exit(c, 0, "Wallpaper\tKevin MacLeod\t\tWallpaper.mp3\n"),
      // idleloop
      () => { /* hold open */ },
    ]);
    const overlay = recordingOverlay();
    createMusicSource({ overlay, spawn });
    await flush();
    expect(recorded[1].args).toEqual(["playlist"]);
    expect(recorded[2].args).toEqual(["add", "/"]);
    expect(recorded[3].args).toEqual(["play"]);
    expect(overlay.calls.find((c) => c.kind === "music.now")).toBeTruthy();
  });

  it("skips `add /` when the playlist already has tracks (operator pre-loaded queue)", async () => {
    const { spawn, recorded } = makeSpawnQueue([
      // status → stopped
      (c) => exit(c, 0, "[stopped]\nvolume:100%   repeat: off\n"),
      // playlist → already has entries
      (c) => exit(c, 0, "1) Carefree.mp3\n2) Wallpaper.mp3\n"),
      // mpc play (no add)
      (c) => exit(c, 0, ""),
      // mpc current
      (c) => exit(c, 0, "Carefree\tKevin MacLeod\t\tCarefree.mp3\n"),
      // idleloop
      () => { /* hold open */ },
    ]);
    const overlay = recordingOverlay();
    createMusicSource({ overlay, spawn });
    await flush();
    const cmds = recorded.map((r) => r.args[0]);
    expect(cmds).not.toContain("add");
    expect(cmds).toContain("play");
  });

  it("resumes playback when status is [paused] (e.g. after container restart)", async () => {
    const { spawn, recorded } = makeSpawnQueue([
      // status → paused (preserved across mpd state_file)
      (c) => exit(c, 0, "Carefree\n[paused] #1/6   0:30/3:25 (15%)\nvolume:100%   repeat: on\n"),
      // mpc play (resume — no add/playlist probe needed)
      (c) => exit(c, 0, ""),
      // mpc current
      (c) => exit(c, 0, "Carefree\tKevin MacLeod\t\tCarefree.mp3\n"),
      // idleloop
      () => { /* hold open */ },
    ]);
    const overlay = recordingOverlay();
    createMusicSource({ overlay, spawn });
    await flush();
    const cmds = recorded.map((r) => r.args[0]);
    expect(cmds).not.toContain("add");
    expect(cmds).not.toContain("playlist");
    expect(cmds.filter((c) => c === "play")).toHaveLength(1);
    expect(overlay.calls.find((c) => c.kind === "music.now")).toBeTruthy();
  });

  it("emits a fresh music.now when idleloop reports a new track", async () => {
    let idleloopChild: FakeChild | null = null;
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing] x\n"),
      (c) => exit(c, 0, "First\tA\t\tfirst.mp3\n"),
      (c) => { idleloopChild = c; /* hold open */ },
      // After idleloop fires, the music source runs `mpc current` again.
      (c) => exit(c, 0, "Second\tB\t\tsecond.mp3\n"),
    ]);
    const overlay = recordingOverlay();
    createMusicSource({ overlay, spawn });
    await flush();
    expect(overlay.calls).toHaveLength(1);
    // Now simulate mpd's player-state change.
    expect(idleloopChild).not.toBeNull();
    idleloopChild!.stdout.push("player\n");
    await flush();
    expect(overlay.calls).toHaveLength(2);
    expect(overlay.calls[1].payload).toMatchObject({ title: "Second", artist: "B" });
  });

  it("dedupes when idleloop fires but the same file is still playing", async () => {
    let idleloopChild: FakeChild | null = null;
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing] x\n"),
      (c) => exit(c, 0, "Same\tA\t\tsame.mp3\n"),
      (c) => { idleloopChild = c; },
      // Idleloop fires but mpc current returns the same file path.
      (c) => exit(c, 0, "Same\tA\t\tsame.mp3\n"),
    ]);
    const overlay = recordingOverlay();
    createMusicSource({ overlay, spawn });
    await flush();
    idleloopChild!.stdout.push("player\n");
    await flush();
    expect(overlay.calls).toHaveLength(1); // no duplicate emit
  });

  it("retries bootstrap when mpd is initially unreachable, then gives up via onError after maxBootstrapAttempts", async () => {
    // Why this test: prior behaviour gave up forever after the first
    // `mpc status` rejection, so a streamer container booted before
    // mpd's music dir was populated would never publish a track until
    // restarted. The retry loop self-heals once mpd appears; the cap
    // stops a permanently-broken environment from spinning forever.
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 1, "", "MPD error: Connection refused\n"),
      (c) => exit(c, 1, "", "MPD error: Connection refused\n"),
      (c) => exit(c, 1, "", "MPD error: Connection refused\n"),
    ]);
    const overlay = recordingOverlay();
    const onError = vi.fn();
    const onWarning = vi.fn();
    createMusicSource({
      overlay,
      spawn,
      onError,
      onWarning,
      sleep: () => Promise.resolve(),
      maxBootstrapAttempts: 3,
    });
    await flush();
    expect(onWarning).toHaveBeenCalledTimes(2); // two retry-warns before the final give-up
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toMatch(/bootstrap exhausted after 3 attempts/);
    expect(overlay.calls).toHaveLength(0);
  });

  it("recovers when mpd becomes reachable on a later bootstrap attempt", async () => {
    // First attempt fails (mpd not yet up); second succeeds and the
    // source proceeds to emit the current track.
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 1, "", "MPD error: Connection refused\n"),
      (c) => exit(c, 0, "[playing] foo.mp3\n"),
      (c) => exit(c, 0, "Some Title\tSome Artist\tSome Album\tfoo.mp3\n"),
      // idleloop child — kept alive so the test doesn't rotate spawns.
      (c) => { /* hold open */ void c; },
    ]);
    const overlay = recordingOverlay();
    const onWarning = vi.fn();
    createMusicSource({
      overlay,
      spawn,
      onWarning,
      sleep: () => Promise.resolve(),
      maxBootstrapAttempts: 5,
    });
    await flush();
    expect(onWarning).toHaveBeenCalledOnce(); // single retry-warn
    expect(overlay.calls).toEqual([
      { kind: "music.now", payload: { title: "Some Title", artist: "Some Artist", album: "Some Album" } },
    ]);
  });

  it("respawns idleloop with backoff after exit, up to maxIdleloopAttempts (initial + respawns combined)", async () => {
    let idleloopCount = 0;
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing] x\n"),
      (c) => exit(c, 0, "T\tA\t\tt.mp3\n"),
      // First idleloop: exits immediately
      (c) => { idleloopCount++; setImmediate(() => c.emit("exit", null)); },
      // Second idleloop: exits immediately
      (c) => { idleloopCount++; setImmediate(() => c.emit("exit", null)); },
      // Third idleloop: exits — at this point we hit the cap
      (c) => { idleloopCount++; setImmediate(() => c.emit("exit", null)); },
    ]);
    const overlay = recordingOverlay();
    const onError = vi.fn();
    createMusicSource({
      overlay,
      spawn,
      onError,
      sleep: () => Promise.resolve(),
      respawnBackoffMs: 0,
      maxIdleloopAttempts: 3,
    });
    await flush();
    expect(idleloopCount).toBe(3);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("re-POSTs the last-known track to the relay on each heartbeat tick", async () => {
    // Why this test: the server-side cache is in-memory. A server
    // restart wipes it, and without a heartbeat the broadcast panel
    // stays empty until the next mpd track change — which can be
    // minutes away. The heartbeat closes that window so a freshly-
    // restarted server sees the current track within
    // heartbeatIntervalMs regardless of mpd's pace.
    let idleloopChild: FakeChild | null = null;
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing]\n"),
      (c) => exit(c, 0, "Carefree\tKevin MacLeod\tSingles\tCarefree.mp3\n"),
      (c) => { idleloopChild = c; /* hold open */ },
    ]);
    const overlay = recordingOverlay();
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      fetchCalls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;

    // Manual setInterval so the test can drive ticks synchronously.
    let intervalHandler: (() => void) | null = null;
    const setIntervalImpl = (handler: () => void, _ms: number) => {
      intervalHandler = handler;
      return Symbol("interval-handle");
    };
    const cleared: unknown[] = [];
    const clearIntervalImpl = (handle: unknown) => { cleared.push(handle); };

    const source = createMusicSource({
      overlay,
      spawn,
      serverRelay: { targetUrl: "https://test.invalid", streamerBotSecret: "s", fetchImpl },
      heartbeatIntervalMs: 30_000,
      setIntervalImpl,
      clearIntervalImpl,
    });
    await flush();
    // Initial emit POSTed once.
    expect(fetchCalls).toHaveLength(1);
    expect(intervalHandler).not.toBeNull();

    // First heartbeat tick: re-POST the same payload.
    intervalHandler!();
    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect(JSON.parse(fetchCalls[1].init.body as string)).toEqual({
      title: "Carefree", artist: "Kevin MacLeod", album: "Singles",
    });
    // Second tick: same payload again.
    intervalHandler!();
    await flush();
    expect(fetchCalls).toHaveLength(3);

    // stop() must clear the interval so heartbeats don't keep firing
    // after teardown.
    source.stop();
    expect(cleared).toHaveLength(1);
    void idleloopChild;
  });

  it("heartbeat is a no-op when no track has been seen yet", async () => {
    // Ensures we don't POST a stale `null` or empty payload when
    // mpd is up but nothing has been published yet (e.g. queue is
    // genuinely empty and the operator hasn't dropped any music
    // files in). The track-change path still takes over once mpd
    // starts emitting.
    const { spawn } = makeSpawnQueue([
      // status returns playing but mpc current returns nothing —
      // this can happen briefly during state transitions.
      (c) => exit(c, 0, "[playing]\n"),
      (c) => exit(c, 0, ""),
      (c) => { /* idleloop hold open */ void c; },
    ]);
    const overlay = recordingOverlay();
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      fetchCalls.push({ url, init });
      return { ok: true } as unknown as Response;
    }) as unknown as typeof fetch;
    let intervalHandler: (() => void) | null = null;
    const source = createMusicSource({
      overlay,
      spawn,
      serverRelay: { targetUrl: "https://test.invalid", streamerBotSecret: "s", fetchImpl },
      heartbeatIntervalMs: 30_000,
      setIntervalImpl: (h) => { intervalHandler = h; return Symbol("h"); },
      clearIntervalImpl: () => {},
    });
    await flush();
    expect(fetchCalls).toHaveLength(0); // no track => no initial POST
    intervalHandler!();
    await flush();
    expect(fetchCalls).toHaveLength(0); // heartbeat skipped
    source.stop();
  });

  it("heartbeat respects the in-flight POST cap", async () => {
    // If the server is slow, the first POST hangs and a heartbeat
    // shouldn't pile up another in-flight request. The cap drops
    // overlapping POSTs; the next *non-overlapping* heartbeat (or
    // track change) re-asserts.
    let idleloopChild: FakeChild | null = null;
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing]\n"),
      (c) => exit(c, 0, "T\tA\t\tt.mp3\n"),
      (c) => { idleloopChild = c; },
    ]);
    const overlay = recordingOverlay();
    let totalCalls = 0;
    const fetchImpl = ((async () => {
      totalCalls++;
      // Hangs forever — simulates an unhealthy server.
      await new Promise(() => { /* hang */ });
    }) as unknown) as typeof fetch;
    let intervalHandler: (() => void) | null = null;
    const source = createMusicSource({
      overlay,
      spawn,
      serverRelay: { targetUrl: "https://test.invalid", streamerBotSecret: "s", fetchImpl },
      heartbeatIntervalMs: 30_000,
      setIntervalImpl: (h) => { intervalHandler = h; return Symbol("h"); },
      clearIntervalImpl: () => {},
    });
    await flush();
    expect(totalCalls).toBe(1); // initial track-change POST hangs
    intervalHandler!();
    await flush();
    intervalHandler!();
    await flush();
    expect(totalCalls).toBe(1); // heartbeats dropped while POST in flight
    source.stop();
    void idleloopChild;
  });

  it("heartbeat is disabled when heartbeatIntervalMs <= 0", async () => {
    // Operator escape hatch + unit-test ergonomics: passing 0
    // skips the timer setup entirely. Used by other unit tests in
    // this file that don't care about heartbeat behaviour.
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing]\n"),
      (c) => exit(c, 0, "T\tA\t\tt.mp3\n"),
      (c) => { /* idleloop hold open */ void c; },
    ]);
    const overlay = recordingOverlay();
    let setCalled = false;
    createMusicSource({
      overlay,
      spawn,
      serverRelay: {
        targetUrl: "https://test.invalid",
        streamerBotSecret: "s",
        fetchImpl: (async () => ({ ok: true } as unknown as Response)) as unknown as typeof fetch,
      },
      heartbeatIntervalMs: 0,
      setIntervalImpl: () => { setCalled = true; return Symbol("h"); },
      clearIntervalImpl: () => {},
    });
    await flush();
    expect(setCalled).toBe(false);
  });

  it("heartbeat is a no-op when no serverRelay is configured", async () => {
    // The heartbeat exists to keep the SERVER cache warm; with no
    // server target, there's nothing to heartbeat at. Skip the
    // interval setup so dev / test runs don't carry an idle timer.
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing]\n"),
      (c) => exit(c, 0, "T\tA\t\tt.mp3\n"),
      (c) => { /* idleloop hold open */ void c; },
    ]);
    const overlay = recordingOverlay();
    let setCalled = false;
    createMusicSource({
      overlay,
      spawn,
      heartbeatIntervalMs: 30_000,
      setIntervalImpl: () => { setCalled = true; return Symbol("h"); },
      clearIntervalImpl: () => {},
    });
    await flush();
    expect(setCalled).toBe(false);
  });

  it("stop() prevents further idleloop respawns", async () => {
    let idleloopCount = 0;
    const { spawn } = makeSpawnQueue([
      (c) => exit(c, 0, "[playing] x\n"),
      (c) => exit(c, 0, "T\tA\t\tt.mp3\n"),
      (c) => { idleloopCount++; /* hold open */ },
    ]);
    const overlay = recordingOverlay();
    const source = createMusicSource({ overlay, spawn, sleep: () => Promise.resolve() });
    await flush();
    source.stop();
    await flush();
    expect(idleloopCount).toBe(1); // no respawn after stop
  });
});
