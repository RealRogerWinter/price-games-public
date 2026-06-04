/**
 * Overlay forwarder — pushes lifecycle / round / chat / music events
 * from the runner into the broadcast page via `window.postMessage`.
 *
 * The receiver lives in `apps/web/src/broadcast/state/overlayBus.ts`
 * (PR 5). The envelope shape (`{ source: 'pg-bot', kind, payload }`)
 * is the runner's contract with the panels — keep them in sync.
 *
 * The forwarder is decoupled from Playwright via a `Dispatch` callback
 * the runner provides. The Driver wraps `page.evaluate(({source,kind,payload}) =>
 * window.postMessage(...))` in that callback. Tests inject a recording
 * fake.
 */

export type OverlayKind =
  | "lifecycle.phase"
  | "round.start"
  | "round.decision"
  | "round.result"
  | "stats.update"
  // Mood snapshot envelope (label + hidden vibe + morale + streak).
  // Mirrors the server-relayed `streamer:mood` socket fan-out so the
  // bot's own Chromium tab receives mood updates synchronously
  // (postMessage) instead of waiting for a server round-trip — the
  // wheel + Avatar parity-fix in PR #345.
  | "mood.snapshot"
  | "chat.message"
  | "music.now"
  | "mp.lobby_countdown"
  | "cursor.aim"
  // Utterance lifecycle envelopes — single source of truth for "what
  // is Pricey saying right now". Subtitle visibility, speaking flag,
  // and Avatar mouth-snap-closed all derive from a single page-side
  // `currentUtterance` reducer keyed off these. PR 4 cutover: legacy
  // tts.line / tts.state / tts.audio_chunk envelopes are removed; PCM
  // is shipped in batches via tts.utterance.audio_batch (~5 chunks /
  // 200ms per envelope) instead of one envelope per chunk to drop
  // CDP IPC overhead 5x.
  | "tts.utterance.start"
  | "tts.utterance.audio_started"
  | "tts.utterance.audio_batch"
  | "tts.utterance.audio_ended"
  | "tts.utterance.cancelled"
  | "nn.tick"
  // Visual-only thought stream — counterpart to the TTS lines. The
  // Thinker module emits these from the runner with mood-tagged
  // text already filled in from the live NN payload. Receiver
  // (broadcast page's ThoughtFeed) maintains a small FIFO of recent
  // thoughts and renders them stacked. See packages/bot-streamer/
  // src/runner/thinker.ts and apps/web/src/broadcast/panels/
  // ThoughtFeed.tsx.
  | "thought.bubble";

export interface OverlayEnvelope {
  source: "pg-bot";
  kind: OverlayKind;
  payload?: unknown;
}

export type OverlayDispatch = (env: OverlayEnvelope) => Promise<void>;

export interface OverlayForwarder {
  send(kind: OverlayKind, payload?: unknown): Promise<void>;
}

export function createOverlayForwarder(dispatch: OverlayDispatch): OverlayForwarder {
  return {
    async send(kind, payload) {
      try {
        await dispatch({ source: "pg-bot", kind, payload });
      } catch {
        // Overlay updates are decorative — never block the lifecycle
        // on a failed dispatch.
      }
    },
  };
}
