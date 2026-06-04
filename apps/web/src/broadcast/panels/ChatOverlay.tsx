import { useEffect, useRef } from "react";
import type { ChatMessage } from "../state/overlayBus";

interface ChatOverlayProps {
  messages: ChatMessage[];
}

const PLATFORM_BADGE: Record<string, string> = {
  twitch: "TW",
  youtube: "YT",
  kick: "KK",
};

/**
 * Aggregated chat from Twitch / YouTube / Kick (delivered through the
 * chat-aggregator → bot controller → overlay bus pipeline). Auto-scrolls
 * to the newest message.
 *
 * No moderation logic here — that lives in the chat aggregator (which has
 * access to platform-specific badges and ban state). This panel only
 * renders what it's given.
 */
export default function ChatOverlay({ messages }: ChatOverlayProps) {
  const scrollRef = useRef<HTMLOListElement>(null);

  // Pin to the bottom whenever a new message lands so viewers always see
  // the latest. Skipped if the user (or test harness) has scrolled up
  // manually — we don't fight them by re-pinning.
  //
  // Why depend on the latest message id instead of `messages.length`:
  // the overlay caps `chat` at CHAT_HISTORY_LIMIT (30) — once the cap
  // is reached, every new message slices an old one off and the array
  // length plateaus at 30. A length-only dep would stop firing after
  // message 31, leaving the panel pinned to whatever it last scrolled
  // to. The id of the last message changes every time a new message
  // arrives, so this dep keeps firing forever.
  const latestId = messages[messages.length - 1]?.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [latestId]);

  return (
    <section
      className="broadcast-chat"
      data-testid="broadcast-chat"
      aria-label="Stream chat"
    >
      <h3 className="broadcast-chat-title">Chat</h3>
      {messages.length === 0 ? (
        <p className="broadcast-chat-empty">No messages yet.</p>
      ) : (
        <ol className="broadcast-chat-list" ref={scrollRef}>
          {messages.map((m) => (
            <li
              key={m.id}
              className="broadcast-chat-message"
              data-testid="chat-message"
              data-platform={m.platform}
            >
              <span className="broadcast-chat-platform" aria-label={`from ${m.platform}`}>
                {PLATFORM_BADGE[m.platform] ?? m.platform.slice(0, 2).toUpperCase()}
              </span>
              <span
                className="broadcast-chat-user"
                style={m.color ? { color: m.color } : undefined}
              >
                {m.user}
              </span>
              <span className="broadcast-chat-text">{m.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
