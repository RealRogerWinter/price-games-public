import { useEffect, useRef, useState } from "react";
import type { MultiplayerPlayer } from "@price-game/shared";
import AvatarIcon from "./AvatarIcon";

/**
 * Top-of-screen notification stack for player join/leave events.
 *
 * Watches the room's `players` array for additions and removals between
 * renders, queueing a toast for each diff. Each toast carries the
 * player's avatar + display name and auto-dismisses after ~3.2s. Two
 * brief Web Audio tones (rising for join, falling for leave) play
 * alongside — no audio assets shipped, just an oscillator burst that
 * works offline and degrades silently when the AudioContext API isn't
 * available (older Safari, prefers-reduced-motion users who blocked it,
 * etc.).
 *
 * Only fires after the first render so opening a populated lobby
 * doesn't dump a stack of "Alice joined / Bob joined / Carol joined"
 * toasts at the user.
 */
interface LobbyEventToastsProps {
  /** Current player list — drives the diff. */
  players: MultiplayerPlayer[];
  /** Local player id. Diffs that involve this id (the user themselves)
   *  are still surfaced because seeing your own join confirms a
   *  successful connect — but the copy uses "you" instead of the name. */
  selfPlayerId: string;
}

interface ToastEntry {
  id: number;
  kind: "join" | "leave";
  player: MultiplayerPlayer;
}

const TOAST_DURATION_MS = 3200;
let nextToastId = 1;

/**
 * Single shared AudioContext — created lazily so we don't pay the cost
 * for users whose browsers block autoplay or who never see a toast. The
 * very first toast that fires after a user gesture (clicking "Create
 * room", "Join room", etc.) will instantiate it; subsequent toasts
 * reuse it.
 */
let cachedAudioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (cachedAudioCtx) return cachedAudioCtx;
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    cachedAudioCtx = new Ctor();
    return cachedAudioCtx;
  } catch {
    return null;
  }
}

/** Brief two-note rising chime (join) or falling chime (leave). */
function playChime(kind: "join" | "leave"): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  // Resume on a user gesture if the context auto-suspended.
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  const now = ctx.currentTime;
  const notes =
    kind === "join" ? [523.25, 783.99] /* C5 → G5 */ : [659.25, 392.0]; /* E5 → G4 */
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.07, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
  gain.connect(ctx.destination);
  for (let i = 0; i < notes.length; i++) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(notes[i], now + i * 0.10);
    osc.connect(gain);
    osc.start(now + i * 0.10);
    osc.stop(now + 0.45);
  }
}

export default function LobbyEventToasts({
  players,
  selfPlayerId,
}: LobbyEventToastsProps): JSX.Element | null {
  const previousIds = useRef<Set<string> | null>(null);
  // Track the previous players list (full records) so we can resolve
  // avatars + names for removals after they're already gone from
  // `players`. Declared before the diff effect so the ref exists when
  // the effect's closure first runs.
  const previousPlayersRef = useRef<MultiplayerPlayer[] | null>(null);
  const [queue, setQueue] = useState<ToastEntry[]>([]);

  useEffect(() => {
    const currentIds = new Set(players.map((p) => p.id));
    if (previousIds.current === null) {
      // First render — seed without toasts so opening a populated lobby
      // doesn't replay "everyone joined" notifications.
      previousIds.current = currentIds;
      previousPlayersRef.current = players;
      return;
    }
    const prev = previousIds.current;
    const additions: MultiplayerPlayer[] = [];
    const removals: MultiplayerPlayer[] = [];
    for (const p of players) {
      if (!prev.has(p.id)) additions.push(p);
    }
    const prevPlayers = previousPlayersRef.current ?? [];
    for (const p of prevPlayers) {
      if (!currentIds.has(p.id)) removals.push(p);
    }

    const newToasts: ToastEntry[] = [
      ...additions.map((p) => ({ id: nextToastId++, kind: "join" as const, player: p })),
      ...removals.map((p) => ({ id: nextToastId++, kind: "leave" as const, player: p })),
    ];
    if (newToasts.length > 0) {
      setQueue((q) => [...q, ...newToasts]);
      playChime(additions.length >= removals.length ? "join" : "leave");
    }

    previousIds.current = currentIds;
    previousPlayersRef.current = players;
  }, [players]);

  // Auto-dismiss timers — scheduled exactly once per toast id. Earlier
  // versions tied a single effect to `[queue]` and rebuilt every timer
  // on every queue change, so when joins arrived in quick succession
  // each new toast would clear and re-create the timers for all
  // already-displayed toasts, resetting their dismiss clocks. The
  // visible symptom: as more players join the toast list never shrinks
  // and the user sees the entire recent history every time someone
  // new joins. Track which ids have a live timer in a ref and only
  // schedule fresh ones; clear all on unmount.
  const dismissTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  useEffect(() => {
    const timers = dismissTimersRef.current;
    for (const t of queue) {
      if (timers.has(t.id)) continue;
      const handle = setTimeout(() => {
        timers.delete(t.id);
        setQueue((q) => q.filter((x) => x.id !== t.id));
      }, TOAST_DURATION_MS);
      timers.set(t.id, handle);
    }
  }, [queue]);

  useEffect(() => {
    const timers = dismissTimersRef.current;
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
  }, []);

  if (queue.length === 0) return null;

  return (
    <div className="lobby-event-toasts" role="status" aria-live="polite">
      {queue.map((t) => {
        const isSelf = t.player.id === selfPlayerId;
        const verb = t.kind === "join" ? "joined" : "left";
        const subject = isSelf ? "You" : t.player.displayName;
        return (
          <div
            key={t.id}
            className={`lobby-event-toast lobby-event-toast--${t.kind}`}
          >
            <AvatarIcon avatar={t.player.avatar} size={32} />
            <span className="lobby-event-toast__text">
              <strong>{subject}</strong> {verb}
            </span>
          </div>
        );
      })}
    </div>
  );
}
