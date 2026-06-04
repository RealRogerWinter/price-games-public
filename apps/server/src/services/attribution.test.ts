import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  validateAttribution,
  storeSignupAttribution,
  hasRecentSignupWithoutAttribution,
  ATTRIBUTION_WINDOW_MINUTES,
} from "./attribution";

let db: DatabaseType;
let userId: string;

beforeEach(() => {
  db = createTestDb();
  userId = seedUser(db);
});

describe("validateAttribution", () => {
  it("returns null for non-object input", () => {
    expect(validateAttribution(null)).toBeNull();
    expect(validateAttribution(undefined)).toBeNull();
    expect(validateAttribution("string")).toBeNull();
    expect(validateAttribution(123)).toBeNull();
    expect(validateAttribution([])).toBeNull();
  });

  it("returns null when the object has no recognized keys", () => {
    expect(validateAttribution({})).toBeNull();
    expect(validateAttribution({ foo: "bar", garbage: 42 })).toBeNull();
  });

  it("returns null when utm_source is missing (required field)", () => {
    // utm_source is the sentinel used by the SQL first-touch guard — its
    // absence would let a follow-up call with a different source overwrite
    // the row. Require it at the validator level to enforce the invariant.
    expect(validateAttribution({ utm_medium: "cpc" })).toBeNull();
    expect(validateAttribution({ utm_campaign: "launch" })).toBeNull();
    expect(
      validateAttribution({
        utm_medium: "cpc",
        utm_campaign: "launch",
        landing_page: "/giveaway",
        referrer: "https://www.reddit.com/",
      }),
    ).toBeNull();
  });

  it("returns null when utm_source is empty string", () => {
    expect(
      validateAttribution({ utm_source: "", utm_campaign: "launch" }),
    ).toBeNull();
  });

  it("extracts recognized UTM keys and ignores unknown keys", () => {
    const result = validateAttribution({
      utm_source: "reddit",
      utm_medium: "cpc",
      utm_campaign: "launch",
      utm_content: "variant_a",
      utm_term: "price",
      landing_page: "/giveaway",
      referrer: "https://www.reddit.com/",
      junk: "should be stripped",
    });

    expect(result).toEqual({
      utm_source: "reddit",
      utm_medium: "cpc",
      utm_campaign: "launch",
      utm_content: "variant_a",
      utm_term: "price",
      landing_page: "/giveaway",
      referrer: "https://www.reddit.com/",
    });
  });

  it("is safe against prototype pollution payloads", () => {
    // A literal `{ __proto__: ... }` is interpreted as the Object.prototype
    // setter, not an own property — so the hasOwnProperty guard in the
    // validator never sees it anyway. Construct a genuine own `__proto__`
    // key via JSON.parse to actually exercise the guard.
    const polluted = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": "evil", "utm_source": "reddit"}',
    );
    const result = validateAttribution(polluted);

    // Validator extracts only the allowlisted key.
    expect(result).toEqual({ utm_source: "reddit" });

    // Object.prototype was not polluted.
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("extracts a partial attribution when some non-source keys are missing", () => {
    // utm_source is required; other fields are optional.
    const result = validateAttribution({
      utm_source: "reddit",
      utm_campaign: "launch",
    });
    expect(result).toEqual({
      utm_source: "reddit",
      utm_campaign: "launch",
    });
  });

  it("clamps each value to 128 characters", () => {
    const long = "x".repeat(500);
    const result = validateAttribution({
      utm_source: long,
      utm_campaign: long,
      landing_page: long,
    });
    expect(result?.utm_source?.length).toBe(128);
    expect(result?.utm_campaign?.length).toBe(128);
    expect(result?.landing_page?.length).toBe(128);
  });

  it("drops non-string values", () => {
    const result = validateAttribution({
      utm_source: "reddit",
      utm_medium: 42,
      utm_campaign: { nested: "value" },
      utm_content: null,
    });
    expect(result).toEqual({ utm_source: "reddit" });
  });

  it("drops empty-string values on non-required fields", () => {
    const result = validateAttribution({
      utm_source: "reddit",
      utm_medium: "",
      utm_campaign: "launch",
    });
    expect(result).toEqual({ utm_source: "reddit", utm_campaign: "launch" });
  });
});

describe("storeSignupAttribution", () => {
  it("writes UTM columns to the users row", () => {
    storeSignupAttribution(db, userId, {
      utm_source: "reddit",
      utm_medium: "cpc",
      utm_campaign: "launch",
      utm_content: "variant_a",
      utm_term: "price",
      landing_page: "/giveaway",
      referrer: "https://www.reddit.com/",
    });

    const row = db
      .prepare(
        "SELECT utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_page, signup_referrer FROM users WHERE id = ?",
      )
      .get(userId) as Record<string, string | null>;

    expect(row.utm_source).toBe("reddit");
    expect(row.utm_medium).toBe("cpc");
    expect(row.utm_campaign).toBe("launch");
    expect(row.utm_content).toBe("variant_a");
    expect(row.utm_term).toBe("price");
    expect(row.landing_page).toBe("/giveaway");
    expect(row.signup_referrer).toBe("https://www.reddit.com/");
  });

  it("writes only the provided fields (others stay NULL)", () => {
    storeSignupAttribution(db, userId, {
      utm_source: "reddit",
    });

    const row = db
      .prepare(
        "SELECT utm_source, utm_medium, utm_campaign FROM users WHERE id = ?",
      )
      .get(userId) as Record<string, string | null>;

    expect(row.utm_source).toBe("reddit");
    expect(row.utm_medium).toBeNull();
    expect(row.utm_campaign).toBeNull();
  });

  it("is a no-op when the user already has utm_source set (first-touch wins)", () => {
    storeSignupAttribution(db, userId, {
      utm_source: "reddit",
      utm_campaign: "first",
    });

    storeSignupAttribution(db, userId, {
      utm_source: "google",
      utm_campaign: "second",
    });

    const row = db
      .prepare("SELECT utm_source, utm_campaign FROM users WHERE id = ?")
      .get(userId) as Record<string, string>;
    expect(row.utm_source).toBe("reddit");
    expect(row.utm_campaign).toBe("first");
  });

  it("ignores payloads without utm_source (would break the first-touch SQL guard)", () => {
    // Bypass validateAttribution and call the storage layer directly with a
    // bad payload to prove the storage layer rejects it. This pins the
    // invariant at two layers of defense — validator AND storage.
    const written = storeSignupAttribution(db, userId, {
      // @ts-expect-error - intentionally testing the bad shape
      utm_campaign: "evil",
    });
    expect(written).toBe(false);

    const row = db
      .prepare("SELECT utm_source, utm_campaign FROM users WHERE id = ?")
      .get(userId) as Record<string, string | null>;
    expect(row.utm_source).toBeNull();
    expect(row.utm_campaign).toBeNull();
  });

  it("does nothing (no throw) when attribution is null", () => {
    expect(() =>
      storeSignupAttribution(db, userId, null),
    ).not.toThrow();

    const row = db
      .prepare("SELECT utm_source FROM users WHERE id = ?")
      .get(userId) as Record<string, string | null>;
    expect(row.utm_source).toBeNull();
  });

  it("does not affect other users' rows", () => {
    const otherId = seedUser(db, "other", "other@example.com");

    storeSignupAttribution(db, userId, {
      utm_source: "reddit",
    });

    const otherRow = db
      .prepare("SELECT utm_source FROM users WHERE id = ?")
      .get(otherId) as Record<string, string | null>;
    expect(otherRow.utm_source).toBeNull();
  });
});

describe("hasRecentSignupWithoutAttribution", () => {
  it("returns true for a freshly-created user with no attribution", () => {
    expect(hasRecentSignupWithoutAttribution(db, userId)).toBe(true);
  });

  it("returns false when the user already has utm_source set", () => {
    storeSignupAttribution(db, userId, { utm_source: "reddit" });
    expect(hasRecentSignupWithoutAttribution(db, userId)).toBe(false);
  });

  it("returns false for a user created outside the attribution window", () => {
    const staleDate = new Date(
      Date.now() - (ATTRIBUTION_WINDOW_MINUTES + 1) * 60 * 1000,
    ).toISOString();
    db.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(
      staleDate,
      userId,
    );

    expect(hasRecentSignupWithoutAttribution(db, userId)).toBe(false);
  });

  it("returns false when the user does not exist", () => {
    expect(
      hasRecentSignupWithoutAttribution(db, "nonexistent-id"),
    ).toBe(false);
  });
});
