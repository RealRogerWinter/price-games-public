import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import { getSiteContent, setSiteContent, CONTENT_MAX_BYTES } from "./siteSettings";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

describe("getSiteContent", () => {
  it("returns a non-empty default for 'about' when unset", () => {
    const c = getSiteContent(db, "about");
    expect(c.key).toBe("about");
    expect(c.title.length).toBeGreaterThan(0);
    if (c.key === "about") expect(typeof c.body).toBe("string");
  });

  it("returns a non-empty default for 'faq' with at least one item", () => {
    const c = getSiteContent(db, "faq");
    expect(c.key).toBe("faq");
    if (c.key === "faq") {
      expect(Array.isArray(c.items)).toBe(true);
      expect(c.items.length).toBeGreaterThan(0);
    }
  });

  it("returns a non-empty default for 'contact'", () => {
    const c = getSiteContent(db, "contact");
    expect(c.key).toBe("contact");
  });

  it("throws for an invalid key", () => {
    expect(() => getSiteContent(db, "bogus")).toThrow();
  });
});

describe("setSiteContent — about", () => {
  it("stores and reads back a sanitized about document", () => {
    setSiteContent(db, "about", { key: "about", title: "T", body: "**bold** body" });
    const c = getSiteContent(db, "about");
    expect(c.key).toBe("about");
    if (c.key === "about") {
      expect(c.title).toBe("T");
      expect(c.body).toBe("**bold** body");
    }
  });

  it("truncates an over-long title to 200 chars", () => {
    const long = "a".repeat(500);
    setSiteContent(db, "about", { key: "about", title: long, body: "" });
    const c = getSiteContent(db, "about");
    if (c.key === "about") expect(c.title.length).toBe(200);
  });

  it("rejects non-object payloads", () => {
    expect(() => setSiteContent(db, "about", "string")).toThrow();
    expect(() => setSiteContent(db, "about", null)).toThrow();
    expect(() => setSiteContent(db, "about", [])).toThrow();
  });

  it("rejects payloads exceeding the size cap", () => {
    const huge = "x".repeat(CONTENT_MAX_BYTES + 10);
    expect(() =>
      setSiteContent(db, "about", { key: "about", title: "T", body: huge }),
    ).toThrow(/maximum size/);
  });
});

describe("setSiteContent — faq", () => {
  it("persists a valid FAQ", () => {
    setSiteContent(db, "faq", {
      key: "faq",
      title: "FAQs",
      items: [{ question: "Q1?", answer: "A1." }],
    });
    const c = getSiteContent(db, "faq");
    if (c.key === "faq") {
      expect(c.items.length).toBe(1);
      expect(c.items[0].question).toBe("Q1?");
    }
  });

  it("drops items with empty question or answer", () => {
    setSiteContent(db, "faq", {
      key: "faq",
      title: "FAQs",
      items: [
        { question: "", answer: "A" },
        { question: "Q", answer: "" },
        { question: "Q", answer: "A" },
      ],
    });
    const c = getSiteContent(db, "faq");
    if (c.key === "faq") {
      expect(c.items.length).toBe(1);
      expect(c.items[0].question).toBe("Q");
    }
  });

  it("drops items missing question/answer keys", () => {
    setSiteContent(db, "faq", {
      key: "faq",
      title: "FAQs",
      items: [null, "notanobject", { nope: "no" }],
    });
    const c = getSiteContent(db, "faq");
    if (c.key === "faq") expect(c.items.length).toBe(0);
  });
});

describe("setSiteContent — contact", () => {
  it("keeps valid http/https social links", () => {
    setSiteContent(db, "contact", {
      key: "contact",
      title: "Contact",
      body: "",
      email: "hello@price.games",
      social: [
        { label: "Twitter", url: "https://twitter.com/price" },
        { label: "Bad", url: "javascript:alert(1)" },
      ],
    });
    const c = getSiteContent(db, "contact");
    if (c.key === "contact") {
      expect(c.social?.length).toBe(1);
      expect(c.social?.[0].url).toBe("https://twitter.com/price");
    }
  });

  it("rejects dangerous schemes in social URLs", () => {
    setSiteContent(db, "contact", {
      key: "contact",
      title: "Contact",
      body: "",
      social: [{ label: "X", url: "javascript:alert(1)" }],
    });
    const c = getSiteContent(db, "contact");
    if (c.key === "contact") expect(c.social?.length).toBe(0);
  });

  it("drops the email when the value isn't a valid email shape", () => {
    setSiteContent(db, "contact", {
      key: "contact",
      title: "Contact",
      body: "",
      email: "not an email",
      social: [],
    });
    const c = getSiteContent(db, "contact");
    if (c.key === "contact") expect(c.email).toBe("");
  });

  it("drops email values that contain dangerous schemes", () => {
    setSiteContent(db, "contact", {
      key: "contact",
      title: "Contact",
      body: "",
      email: "javascript:alert(1)",
      social: [],
    });
    const c = getSiteContent(db, "contact");
    if (c.key === "contact") expect(c.email).toBe("");
  });

  it("keeps a valid email", () => {
    setSiteContent(db, "contact", {
      key: "contact",
      title: "Contact",
      body: "",
      email: "hello@price.games",
      social: [],
    });
    const c = getSiteContent(db, "contact");
    if (c.key === "contact") expect(c.email).toBe("hello@price.games");
  });

  it("keeps an empty email (explicit clear)", () => {
    setSiteContent(db, "contact", {
      key: "contact",
      title: "Contact",
      body: "",
      email: "",
      social: [],
    });
    const c = getSiteContent(db, "contact");
    if (c.key === "contact") expect(c.email).toBe("");
  });
});

describe("setSiteContent — schema normalization", () => {
  it("ignores the body's `key` field and stamps the URL-supplied key instead", () => {
    // A malicious / buggy payload could try to smuggle a different `key`
    // in the body (e.g. about data sent to the faq endpoint). The stored
    // document's key is dictated by the URL param, not the body.
    setSiteContent(db, "faq", { key: "about", title: "F", items: [{ question: "Q", answer: "A" }] });
    const c = getSiteContent(db, "faq");
    expect(c.key).toBe("faq");
    if (c.key === "faq") expect(c.items.length).toBe(1);
  });

  it("drops stray top-level keys from the payload (no prototype pollution)", () => {
    setSiteContent(db, "about", { title: "T", body: "B", __proto__: { evil: true }, constructor: "bad", extra: 1 } as unknown);
    const c = getSiteContent(db, "about") as unknown as Record<string, unknown>;
    expect(c.extra).toBeUndefined();
    expect(c.constructor).not.toBe("bad");
    expect((({} as Record<string, unknown>).evil)).toBeUndefined();
  });
});
