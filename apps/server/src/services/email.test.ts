/**
 * Tests for the email service module.
 *
 * Mocks the Resend SDK and config to verify email sending, template rendering,
 * HTML escaping, and dev-mode fallback behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock config and Resend using vi.hoisted ─────────────────────────────

const { configOverrides, mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn();
  return {
    configOverrides: {
      resendApiKey: "" as string,
      emailFrom: "Price Games <noreply@price.games>",
      appUrl: "http://localhost:5173",
    },
    mockSend,
  };
});

vi.mock("../config", () => ({
  config: configOverrides,
}));

vi.mock("resend", () => ({
  Resend: function FakeResend() {
    return { emails: { send: mockSend } };
  },
}));

// Import after mocks are set up
import {
  escapeHtml,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendRewardAwardedEmail,
  sendClaimReminderEmail,
  sendRewardExpiredEmail,
  buildGiveawayLossEmail,
} from "./email";
import { _resetOutboundLinksCacheForTests } from "./outboundLinks";
import { createTestDb } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

// ── Helpers ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSend.mockReset();
  // Default: dev mode (no API key)
  configOverrides.resendApiKey = "";
  configOverrides.emailFrom = "Price Games <noreply@price.games>";
  configOverrides.appUrl = "http://localhost:5173";
});

// ── escapeHtml ──────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes greater-than", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("escapes single quotes", () => {
    expect(escapeHtml("a'b")).toBe("a&#x27;b");
  });

  it("escapes all special chars in a single string", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#x27;");
  });

  it("returns an empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("returns a plain string unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });
});

// ── send (dev mode — no API key) ────────────────────────────────────────

describe("send — dev mode (no API key)", () => {
  it("logs to console and returns true when Resend is not configured", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    configOverrides.resendApiKey = "";

    const result = await sendVerificationEmail("user@example.com", "TestUser", "abc123");

    expect(result).toBe(true);
    // Should have logged dev email output
    const logCalls = consoleSpy.mock.calls.map((c) => c[0]);
    const hasDevLog = logCalls.some((msg) => typeof msg === "string" && msg.includes("[email:dev]"));
    expect(hasDevLog).toBe(true);
    consoleSpy.mockRestore();
  });

  it("does not call Resend SDK when no API key is set", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    configOverrides.resendApiKey = "";

    await sendVerificationEmail("user@example.com", "TestUser", "abc123");

    expect(mockSend).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ── send with Resend configured ─────────────────────────────────────────

describe("send — Resend configured", () => {
  beforeEach(() => {
    configOverrides.resendApiKey = "re_test_key_12345";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("calls Resend emails.send with correct params on success", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    const result = await sendVerificationEmail("user@example.com", "TestUser", "tok123");

    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.from).toBe(configOverrides.emailFrom);
    expect(callArgs.to).toBe("user@example.com");
    expect(callArgs.subject).toContain("Verify your email");
    expect(callArgs.html).toContain("tok123");
  });

  it("returns false when Resend returns an error object", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSend.mockResolvedValueOnce({ data: null, error: { message: "Invalid API key" } });

    const result = await sendVerificationEmail("user@example.com", "TestUser", "tok123");

    expect(result).toBe(false);
  });

  it("returns false when Resend throws an exception", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSend.mockRejectedValueOnce(new Error("Network failure"));

    const result = await sendVerificationEmail("user@example.com", "TestUser", "tok123");

    expect(result).toBe(false);
  });
});

// ── sendVerificationEmail ───────────────────────────────────────────────

describe("sendVerificationEmail", () => {
  beforeEach(() => {
    configOverrides.resendApiKey = "re_test_key_12345";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("sends with correct subject containing 'Verify your email'", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendVerificationEmail("user@example.com", "TestUser", "mytoken");

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.subject).toBe("Verify your email — Price Games");
  });

  it("includes the verification URL with the token in the body", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendVerificationEmail("user@example.com", "TestUser", "mytoken");

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.html).toContain(`${configOverrides.appUrl}/verify-email?token=mytoken`);
  });

  it("includes the escaped username in the body", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendVerificationEmail("user@example.com", "User<script>", "mytoken");

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.html).toContain("User&lt;script&gt;");
    expect(callArgs.html).not.toContain("User<script>");
  });

  it("UTM-tags the verification URL with the email:verify origin", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendVerificationEmail("user@example.com", "TestUser", "mytoken");

    const html = mockSend.mock.calls[0][0].html as string;
    expect(html).toContain("utm_source=email");
    expect(html).toContain("utm_medium=transactional");
    expect(html).toContain("utm_campaign=verify_email");
  });
});

// ── sendPasswordResetEmail ──────────────────────────────────────────────

describe("sendPasswordResetEmail", () => {
  beforeEach(() => {
    configOverrides.resendApiKey = "re_test_key_12345";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("sends with correct subject containing 'Reset your password'", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendPasswordResetEmail("user@example.com", "TestUser", "resettoken");

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.subject).toBe("Reset your password — Price Games");
  });

  it("includes the reset URL with the token in the body", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendPasswordResetEmail("user@example.com", "TestUser", "resettoken");

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.html).toContain(`${configOverrides.appUrl}/reset-password?token=resettoken`);
  });

  it("includes the escaped username in the body", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendPasswordResetEmail("user@example.com", 'User"Evil"', "resettoken");

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.html).toContain("User&quot;Evil&quot;");
  });

  it("UTM-tags the reset URL with the email:password_reset origin", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendPasswordResetEmail("user@example.com", "TestUser", "resettoken");

    const html = mockSend.mock.calls[0][0].html as string;
    expect(html).toContain("utm_source=email");
    expect(html).toContain("utm_campaign=password_reset");
  });
});

// ── sendRewardAwardedEmail ──────────────────────────────────────────────

describe("sendRewardAwardedEmail", () => {
  const claimUrl = "https://example.test/claim/abc123";
  const claimExpiresAt = "2026-06-02T00:00:00.000Z";

  beforeEach(() => {
    configOverrides.resendApiKey = "re_test_key_12345";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("formats amount correctly from cents to dollars", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendRewardAwardedEmail("user@example.com", "TestUser", 2500, "amazon_gift_card", claimUrl, claimExpiresAt);

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.html).toContain("$25.00");
  });

  it("uses 'Amazon Gift Card' label for amazon_gift_card reward type", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendRewardAwardedEmail("user@example.com", "TestUser", 1000, "amazon_gift_card", claimUrl, claimExpiresAt);

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.subject).toContain("$10.00 Amazon Gift Card");
    expect(callArgs.html).toContain("Amazon Gift Card");
  });

  it("uses 'Reward' label for unknown reward types", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendRewardAwardedEmail("user@example.com", "TestUser", 500, "other_type", claimUrl, claimExpiresAt);

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.subject).toContain("$5.00 Reward");
  });

  it("includes correct subject format", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendRewardAwardedEmail("user@example.com", "TestUser", 2500, "amazon_gift_card", claimUrl, claimExpiresAt);

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.subject).toBe("You won a $25.00 Amazon Gift Card! — Price Games");
  });

  it("handles cent amounts that produce fractional dollars", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendRewardAwardedEmail("user@example.com", "TestUser", 99, "amazon_gift_card", claimUrl, claimExpiresAt);

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.html).toContain("$0.99");
  });

  it("includes claim URL in the body (not the generic /settings link)", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendRewardAwardedEmail("user@example.com", "TestUser", 1000, "amazon_gift_card", claimUrl, claimExpiresAt);

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.html).toContain(claimUrl);
  });

  it("includes the 30-day deadline date in the body", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendRewardAwardedEmail("user@example.com", "TestUser", 1000, "amazon_gift_card", claimUrl, claimExpiresAt);

    const callArgs = mockSend.mock.calls[0][0];
    expect(callArgs.html).toContain("June 2, 2026");
    expect(callArgs.html).toContain("within 30 days");
  });

  it("UTM-tags the claim URL with the email:reward_awarded origin", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendRewardAwardedEmail("user@example.com", "TestUser", 1000, "amazon_gift_card", claimUrl, claimExpiresAt);

    const html = mockSend.mock.calls[0][0].html as string;
    // UTM params present
    expect(html).toContain("utm_source=email");
    expect(html).toContain("utm_medium=transactional");
    expect(html).toContain("utm_campaign=reward_awarded");
    // Per-recipient claim URL is NOT short-linked (would require per-user codes)
    expect(html).not.toContain("/go/");
  });
});

// ── sendClaimReminderEmail ──────────────────────────────────────────────

describe("sendClaimReminderEmail UTM tagging", () => {
  const claimUrl = "https://example.test/claim/abc123";
  const claimExpiresAt = "2026-06-02T00:00:00.000Z";

  beforeEach(() => {
    configOverrides.resendApiKey = "re_test_key_12345";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it.each([
    [15, "15d"],
    [7, "7d"],
    [1, "1d"],
  ] as const)(
    "tags the claim URL with utm_content=%s for the %d-day reminder",
    async (daysLeft, expectedContent) => {
      mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

      await sendClaimReminderEmail(
        "user@example.com",
        "TestUser",
        1000,
        daysLeft,
        claimExpiresAt,
        claimUrl,
      );

      const html = mockSend.mock.calls[0][0].html as string;
      expect(html).toContain("utm_source=email");
      expect(html).toContain("utm_campaign=reward_reminder");
      expect(html).toContain(`utm_content=${expectedContent}`);
      // Tokenized URL — no short-link.
      expect(html).not.toContain("/go/");
    },
  );
});

// ── sendRewardExpiredEmail ──────────────────────────────────────────────

describe("sendRewardExpiredEmail UTM short-linking", () => {
  let db: DatabaseType;

  beforeEach(() => {
    configOverrides.resendApiKey = "re_test_key_12345";
    vi.spyOn(console, "log").mockImplementation(() => {});
    db = createTestDb();
    _resetOutboundLinksCacheForTests();
  });

  it("substitutes the dashboard CTA with a short link tagged email:reward_expired", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });

    await sendRewardExpiredEmail(db, "user@example.com", "TestUser", 1000, "amazon_gift_card");

    const html = mockSend.mock.calls[0][0].html as string;
    // Short URL on the CTA — `/go/<code>` substitution.
    expect(html).toMatch(/href="[^"]*\/go\/[a-z0-9]{3,32}"/);

    // Backing system row exists with the correct UTM tuple. The
    // destination is normalized to "/" (config.appUrl is the bare app
    // origin, which strips to root path through normalizeDestination).
    const row = db
      .prepare(
        `SELECT * FROM utm_tags WHERE origin_key = 'email:reward_expired'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.utm_source).toBe("email");
    expect(row?.utm_campaign).toBe("reward_expired");
    expect(row?.destination_url).toBe("/");
  });
});

// ── buildGiveawayLossEmail ──────────────────────────────────────────────

describe("buildGiveawayLossEmail UTM short-linking", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = createTestDb();
    _resetOutboundLinksCacheForTests();
  });

  it("uses the same short link in the HTML CTA and the plain-text body", () => {
    const { html, text } = buildGiveawayLossEmail(db, {
      username: "Player",
      period: "last_week",
    });

    const htmlMatch = html.match(/href="([^"]*\/go\/[a-z0-9]{3,32})"/);
    const textMatch = text.match(/(https?:\/\/[^\s]*\/go\/[a-z0-9]{3,32})/);
    expect(htmlMatch).not.toBeNull();
    expect(textMatch).not.toBeNull();
    expect(htmlMatch?.[1]).toBe(textMatch?.[1]);
  });

  it("creates a system utm_tags row tagged email:giveaway_loss", () => {
    buildGiveawayLossEmail(db, { username: "Player", period: "last_month" });

    const row = db
      .prepare(
        `SELECT utm_source, utm_medium, utm_campaign FROM utm_tags
          WHERE origin_key = 'email:giveaway_loss'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.utm_source).toBe("email");
    expect(row?.utm_medium).toBe("lifecycle");
    expect(row?.utm_campaign).toBe("giveaway_loss");
  });
});

// ── Public-host regression guard ────────────────────────────────────────

/**
 * Regression guard for an earlier UTM-system bug where generated URLs
 * leaked the Tailscale admin hostname instead of the public price.games
 * origin. The fix at the time was to make the web-side
 * `getPublicSiteOrigin()` always resolve to https://price.games. The
 * server side never had the bug because it reads from APP_URL (set to
 * https://price.games in production), but these tests pin the contract
 * so a future refactor that introduces request-derived URL building
 * would fail loudly here.
 */
describe("outbound URLs use config.appUrl, not request-derived hosts", () => {
  let db: DatabaseType;

  beforeEach(() => {
    configOverrides.resendApiKey = "re_test_key_12345";
    configOverrides.appUrl = "https://price.games";
    vi.spyOn(console, "log").mockImplementation(() => {});
    db = createTestDb();
    _resetOutboundLinksCacheForTests();
  });

  it("verify-email URL uses the configured public origin", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });
    await sendVerificationEmail("user@example.com", "User", "abc");

    const html = mockSend.mock.calls[0][0].html as string;
    expect(html).toContain("https://price.games/verify-email?token=abc");
    expect(html).not.toMatch(/ts\.net|tailscale/i);
  });

  it("password-reset URL uses the configured public origin", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });
    await sendPasswordResetEmail("user@example.com", "User", "xyz");

    const html = mockSend.mock.calls[0][0].html as string;
    expect(html).toContain("https://price.games/reset-password?token=xyz");
    expect(html).not.toMatch(/ts\.net|tailscale/i);
  });

  it("reward-expired short URL uses the configured public origin", async () => {
    mockSend.mockResolvedValueOnce({ data: { id: "email_1" }, error: null });
    await sendRewardExpiredEmail(db, "user@example.com", "User", 1000, "amazon_gift_card");

    const html = mockSend.mock.calls[0][0].html as string;
    expect(html).toMatch(/href="https:\/\/price\.games\/go\/[a-z0-9]{3,32}"/);
    expect(html).not.toMatch(/ts\.net|tailscale/i);
  });

  it("giveaway-loss short URL uses the configured public origin (HTML + text)", () => {
    const { html, text } = buildGiveawayLossEmail(db, {
      username: "User",
      period: "last_week",
    });
    expect(html).toMatch(/href="https:\/\/price\.games\/go\/[a-z0-9]{3,32}"/);
    expect(text).toMatch(/https:\/\/price\.games\/go\/[a-z0-9]{3,32}/);
    expect(html).not.toMatch(/ts\.net|tailscale/i);
    expect(text).not.toMatch(/ts\.net|tailscale/i);
  });
});
