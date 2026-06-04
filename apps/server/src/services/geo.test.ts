import { describe, it, expect, beforeEach } from "vitest";
import { lookupGeo, getIp, __resetMaxmindReader } from "./geo";

beforeEach(() => {
  __resetMaxmindReader();
  delete process.env.MAXMIND_DB_PATH;
});

function fakeReq(headers: Record<string, string | string[] | undefined>, ip?: string) {
  return { headers, ip, socket: { remoteAddress: ip ?? null } } as unknown as Parameters<
    typeof lookupGeo
  >[0];
}

describe("lookupGeo — Cloudflare CF-IPCountry primary", () => {
  it("uses CF-IPCountry when present", () => {
    const geo = lookupGeo(fakeReq({ "cf-ipcountry": "US", "cf-region-code": "CA" }));
    expect(geo.country).toBe("US");
    expect(geo.region).toBe("CA");
  });

  it("ignores Cloudflare placeholder country codes", () => {
    const geo = lookupGeo(fakeReq({ "cf-ipcountry": "XX" }));
    expect(geo.country).toBeNull();
  });

  it("ignores 'T1' (Tor) country code", () => {
    const geo = lookupGeo(fakeReq({ "cf-ipcountry": "T1" }));
    expect(geo.country).toBeNull();
  });

  it("uppercases country codes", () => {
    const geo = lookupGeo(fakeReq({ "cf-ipcountry": "de" }));
    expect(geo.country).toBe("DE");
  });
});

describe("lookupGeo — MaxMind fallback", () => {
  it("returns nulls when MaxMind DB is not configured", () => {
    const geo = lookupGeo(fakeReq({}, "1.2.3.4"));
    expect(geo.country).toBeNull();
    expect(geo.region).toBeNull();
  });

  it("returns nulls when MaxMind DB path points at a missing file", () => {
    process.env.MAXMIND_DB_PATH = "/tmp/nope-does-not-exist.mmdb";
    const geo = lookupGeo(fakeReq({}, "1.2.3.4"));
    expect(geo.country).toBeNull();
  });
});

describe("getIp", () => {
  it("prefers CF-Connecting-IP when present", () => {
    const ip = getIp(fakeReq({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }, "3.3.3.3"));
    expect(ip).toBe("1.1.1.1");
  });

  it("falls back to X-Forwarded-For first entry", () => {
    const ip = getIp(fakeReq({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, "3.3.3.3"));
    expect(ip).toBe("1.1.1.1");
  });

  it("falls back to req.ip", () => {
    const ip = getIp(fakeReq({}, "4.4.4.4"));
    expect(ip).toBe("4.4.4.4");
  });

  it("returns null if no IP available", () => {
    const ip = getIp(fakeReq({}));
    expect(ip).toBeNull();
  });
});
