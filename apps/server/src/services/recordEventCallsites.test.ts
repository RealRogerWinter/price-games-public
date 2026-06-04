/**
 * Lint-style test: every server-side `recordEvent` / `recordEventFromRequest`
 * call must either supply a `clientEventId` (so the events table's
 * `UNIQUE(visitor_id, client_event_id)` index can absorb duplicate
 * emissions) OR be in the explicit allowlist of callsites where
 * dedup is intentionally skipped.
 *
 * Why this exists: PR 6a discovered that several server-emitted events
 * (mp_room_created, mp_game_completed, etc.) had no clientEventId, so a
 * double-fire of the originating state transition silently wrote duplicate
 * rows. PR 6a added deterministic keys at every site; this test prevents
 * regression. Without this guard, a future contributor could add a new
 * recordEvent call without a key and break dedup invariants — the e2e
 * tests added in PR 6 would still pass for happy-path scenarios because
 * no retry happens, but production replay scenarios would silently
 * inflate the metrics.
 *
 * Mechanism: read the source of every server file under apps/server/src,
 * find every `recordEvent(` and `recordEventFromRequest(` call, parse the
 * argument object literal, and assert it includes a `clientEventId:` key
 * or is in the allowlist below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, relative } from "path";
import { execSync } from "child_process";

const SERVER_ROOT = join(__dirname, "..");
const REPO_ROOT_RELATIVE = "apps/server/src";

/**
 * Allowlist of (file, eventName) tuples where omitting clientEventId is
 * intentional. Each entry must include a one-line justification.
 *
 * Add entries grudgingly — every entry is a place where a retry can
 * silently double-count. Prefer adding a deterministic clientEventId.
 */
const ALLOWLIST: Array<{ file: string; eventName: string; reason: string }> = [
  {
    file: "apps/server/src/routes/user.ts",
    eventName: "USER_LOGGED_IN",
    reason:
      "Each successful login mints a fresh session token (a new logical event). " +
      "Retries from rapid double-clicks each create real sessions; a dedup key " +
      "scoped on the new token would produce distinct keys anyway. Genuine event " +
      "frequency is low (one per user per hour at most) so the lack of dedup " +
      "doesn't materially affect dashboards.",
  },
  {
    file: "apps/server/src/routes/user.ts",
    eventName: "USER_LOGGED_OUT",
    reason:
      "Mirror of USER_LOGGED_IN — each logout is tied to a destroyed session. " +
      "Retries against an already-destroyed session no-op silently; the second " +
      "event is rare enough to not warrant a dedup-key scope.",
  },
];

interface CallSite {
  file: string;
  line: number;
  fnName: "recordEvent" | "recordEventFromRequest";
  body: string; // text from "recordEvent(" through matching closing ")"
  eventName: string | null;
  hasClientEventId: boolean;
}

/**
 * Find every recordEvent / recordEventFromRequest callsite in server src,
 * extract its argument body, and parse out (eventName, hasClientEventId).
 *
 * The parser is a balanced-paren scanner — it tracks nesting depth so
 * nested calls / object literals don't confuse the closing paren match.
 * Strings ('...', "...", `...`) are skipped wholesale to avoid commas
 * inside them counting as separators.
 */
function collectCallSites(): CallSite[] {
  const grepOutput = execSync(
    `grep -rEn "recordEvent(FromRequest)?\\s*\\(" "${SERVER_ROOT}" --include="*.ts" --exclude-dir=node_modules --exclude="*.test.ts" --exclude="recordEventCallsites.test.ts"`,
    { encoding: "utf8" },
  );

  const sites: CallSite[] = [];
  for (const grepLine of grepOutput.split("\n")) {
    const m = /^([^:]+):(\d+):/.exec(grepLine);
    if (!m) continue;
    const filePath = m[1];
    const lineNum = parseInt(m[2], 10);

    // Skip the eventLog source itself (defines the function) and the
    // exported re-binding in this lint test.
    if (filePath.endsWith("eventLog.ts")) continue;
    if (filePath.endsWith("recordEventCallsites.test.ts")) continue;

    const source = readFileSync(filePath, "utf8");
    const lines = source.split("\n");

    // Find the opening `recordEvent(` or `recordEventFromRequest(` on this line.
    const startLineIdx = lineNum - 1;
    const startLineText = lines[startLineIdx];
    const fnMatch = /\b(recordEvent|recordEventFromRequest)\s*\(/.exec(startLineText);
    if (!fnMatch) continue;
    const fnName = fnMatch[1] as CallSite["fnName"];
    const callStart = startLineIdx;
    const openOffset = fnMatch.index + fnMatch[0].length;

    // Walk forward, balancing parens, skipping strings, until depth returns to 0.
    let depth = 1;
    let buffer = startLineText.slice(openOffset);
    let bodyParts: string[] = [];
    let lineIdx = startLineIdx;
    let cursor = 0;
    let done = false;

    while (!done && lineIdx < lines.length) {
      const text = lineIdx === startLineIdx ? buffer : lines[lineIdx];
      cursor = 0;
      while (cursor < text.length) {
        const ch = text[cursor];
        // Skip string literals.
        if (ch === "'" || ch === '"' || ch === "`") {
          const quote = ch;
          cursor += 1;
          while (cursor < text.length && text[cursor] !== quote) {
            if (text[cursor] === "\\") cursor += 1; // escape
            cursor += 1;
          }
          cursor += 1;
          continue;
        }
        // Skip line comments.
        if (ch === "/" && text[cursor + 1] === "/") {
          cursor = text.length;
          continue;
        }
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth === 0) {
            bodyParts.push(text.slice(0, cursor));
            done = true;
            break;
          }
        }
        cursor += 1;
      }
      if (!done) {
        bodyParts.push(text);
        lineIdx += 1;
      }
    }

    const body = bodyParts.join("\n");
    // Extract eventName from the body: look for `eventName: ANALYTICS_EVENTS.X`
    // or eventName: "literal" or `eventName: result.session?.completed ? X : Y`
    // (in which case both branches must be in allowlist or have keys; we
    //  resolve the literal symbols inside).
    const eventNameMatch = /eventName\s*:\s*ANALYTICS_EVENTS\.([A-Z_]+)/.exec(body);
    const ternaryEventNames = Array.from(
      body.matchAll(/ANALYTICS_EVENTS\.([A-Z_]+)/g),
    ).map((mm) => mm[1]);

    const hasClientEventId = /\bclientEventId\s*:/.test(body);

    if (eventNameMatch) {
      sites.push({
        file: relative(join(SERVER_ROOT, "..", "..", ".."), filePath),
        line: callStart + 1,
        fnName,
        body,
        eventName: eventNameMatch[1],
        hasClientEventId,
      });
    } else if (ternaryEventNames.length > 0) {
      // Conditional eventName — fan out to one CallSite per branch.
      for (const en of ternaryEventNames) {
        sites.push({
          file: relative(join(SERVER_ROOT, "..", "..", ".."), filePath),
          line: callStart + 1,
          fnName,
          body,
          eventName: en,
          hasClientEventId,
        });
      }
    } else {
      sites.push({
        file: relative(join(SERVER_ROOT, "..", "..", ".."), filePath),
        line: callStart + 1,
        fnName,
        body,
        eventName: null,
        hasClientEventId,
      });
    }
  }
  return sites;
}

function isAllowlisted(site: CallSite): boolean {
  if (!site.eventName) return false;
  return ALLOWLIST.some(
    (a) => a.file === site.file && a.eventName === site.eventName,
  );
}

describe("recordEvent callsite lint", () => {
  const sites = collectCallSites();

  it("finds at least one recordEvent callsite (sanity check)", () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it("every callsite has a parseable eventName OR is a passthrough (eventName + clientEventId both forwarded)", () => {
    // Passthrough = eventName is a variable AND clientEventId is supplied.
    // The beacon endpoint (`routes/events.ts`) is the canonical case: it
    // forwards `ev.name` and `ev.clientEventId` from the validated envelope
    // straight through. The literal-eventName regex won't match the
    // variable, but the dedup invariant still holds because the beacon's
    // own clientEventId reaches the events table.
    const unparseable = sites.filter(
      (s) => !s.eventName && !s.hasClientEventId,
    );
    if (unparseable.length > 0) {
      const summary = unparseable
        .map((s) => `  - ${s.file}:${s.line} (${s.fnName})`)
        .join("\n");
      throw new Error(
        `Found recordEvent callsites with unparseable eventName AND no clientEventId:\n${summary}\n\n` +
          `Either rewrite the call to use ANALYTICS_EVENTS.X directly, or update ` +
          `the parser in ${REPO_ROOT_RELATIVE}/services/recordEventCallsites.test.ts.`,
      );
    }
    expect(unparseable).toEqual([]);
  });

  it("every callsite either supplies clientEventId OR is on the allowlist", () => {
    const violations = sites.filter(
      (s) => !s.hasClientEventId && !isAllowlisted(s),
    );
    if (violations.length > 0) {
      const summary = violations
        .map(
          (s) =>
            `  - ${s.file}:${s.line} emits ${s.eventName} without clientEventId`,
        )
        .join("\n");
      throw new Error(
        `Found server-side recordEvent callsites with no dedup key:\n${summary}\n\n` +
          `Each must either:\n` +
          `  (a) supply a deterministic \`clientEventId\` so the events table's\n` +
          `      UNIQUE(visitor_id, client_event_id) index can absorb retries, OR\n` +
          `  (b) be added to the ALLOWLIST in ${REPO_ROOT_RELATIVE}/services/recordEventCallsites.test.ts\n` +
          `      with a one-line justification.\n\n` +
          `Recommended key shape: \`srv:<eventName>:<scopeKey>\` where scopeKey is\n` +
          `whatever uniquely identifies this logical event (sessionId, gameId,\n` +
          `playerId, etc.). See PR 6a for examples.`,
      );
    }
    expect(violations).toEqual([]);
  });

  it("every allowlist entry corresponds to a real callsite (no stale entries)", () => {
    const reachable = new Set(sites.map((s) => `${s.file}|${s.eventName}`));
    const stale = ALLOWLIST.filter(
      (a) => !reachable.has(`${a.file}|${a.eventName}`),
    );
    expect(stale).toEqual([]);
  });
});
