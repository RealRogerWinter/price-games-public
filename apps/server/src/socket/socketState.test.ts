import { describe, it, expect, afterEach } from "vitest";
import {
  getClientIp,
  schedulePendingDisconnect,
  hasPendingDisconnect,
  cancelAllPendingDisconnects,
  setDisconnectGraceMs,
} from "./socketState";

function mockSocket(address: string, headers: Record<string, string> = {}): any {
  return {
    handshake: {
      address,
      headers,
    },
  };
}

describe("getClientIp", () => {
  it("returns direct IP for non-loopback connections", () => {
    const socket = mockSocket("203.0.113.50");
    expect(getClientIp(socket)).toBe("203.0.113.50");
  });

  it("ignores X-Forwarded-For for non-loopback connections", () => {
    const socket = mockSocket("203.0.113.50", {
      "x-forwarded-for": "10.0.0.1",
    });
    expect(getClientIp(socket)).toBe("203.0.113.50");
  });

  it("reads X-Forwarded-For for IPv4 loopback (127.0.0.1)", () => {
    const socket = mockSocket("127.0.0.1", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  it("reads X-Forwarded-For for IPv6 loopback (::1)", () => {
    const socket = mockSocket("::1", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  it("reads X-Forwarded-For for IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    const socket = mockSocket("::ffff:127.0.0.1", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  // Production runs the Express server in a Docker container behind Caddy on
  // the host. Connections from Caddy → host:3001 → docker port mapping
  // appear to the container with source IP = the docker bridge gateway (an
  // RFC-1918 address like 172.18.0.1), NOT loopback. We must honor
  // X-Forwarded-For from those sources too — otherwise every external client
  // shares one IP and any per-IP socket limiter (room creation, room join)
  // becomes a global limiter.
  it("reads X-Forwarded-For for docker bridge gateway (172.18.0.1)", () => {
    const socket = mockSocket("172.18.0.1", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  it("reads X-Forwarded-For for RFC-1918 10/8 sources", () => {
    const socket = mockSocket("10.0.0.5", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  it("reads X-Forwarded-For for RFC-1918 192.168/16 sources", () => {
    const socket = mockSocket("192.168.1.10", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  it("reads X-Forwarded-For for IPv4-mapped IPv6 RFC-1918 (::ffff:172.18.0.1)", () => {
    const socket = mockSocket("::ffff:172.18.0.1", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  it("reads X-Forwarded-For for IPv4-mapped IPv6 RFC-1918 10/8 (::ffff:10.0.0.5)", () => {
    const socket = mockSocket("::ffff:10.0.0.5", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  it("reads X-Forwarded-For for IPv4-mapped IPv6 RFC-1918 192.168/16 (::ffff:192.168.1.10)", () => {
    const socket = mockSocket("::ffff:192.168.1.10", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  it("normalizes mixed-case IPv4-mapped IPv6 prefix (::FFFF:172.18.0.1)", () => {
    const socket = mockSocket("::FFFF:172.18.0.1", {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe("198.51.100.42");
  });

  // IPv6 link-local fe80::/10 — RFC 4291 says the high two bits of the
  // second nibble are `10`, so fe80, fe90, fea0, feb0 are all valid.
  it.each(["fe80::1", "fe90::1", "fea0::1", "feb0::1"])(
    "reads X-Forwarded-For for IPv6 link-local source (%s)",
    (addr) => {
      const socket = mockSocket(addr, {
        "x-forwarded-for": "198.51.100.42",
      });
      expect(getClientIp(socket)).toBe("198.51.100.42");
    },
  );

  // IPv6 unique-local fc00::/7 — fc.. and fd.. prefixes.
  it.each(["fc00::1", "fd00::1", "fdab::1"])(
    "reads X-Forwarded-For for IPv6 unique-local source (%s)",
    (addr) => {
      const socket = mockSocket(addr, {
        "x-forwarded-for": "198.51.100.42",
      });
      expect(getClientIp(socket)).toBe("198.51.100.42");
    },
  );

  // Negative boundary tests pin down the 172.16/12 range so a future
  // refactor can't silently drop the upper bound or widen to 172.0/8.
  it.each([
    ["172.15.0.1", "172.15 sits below the RFC-1918 range"],
    ["172.32.0.1", "172.32 sits above the RFC-1918 range"],
    ["172.0.0.1", "172.0 is public"],
    ["172.255.0.1", "172.255 is public"],
  ])("ignores X-Forwarded-For for non-RFC-1918 172.x source (%s)", (addr) => {
    const socket = mockSocket(addr, {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe(addr);
  });

  // Hostname-shaped strings must be rejected — even if `socket.handshake.address`
  // is always a numeric IP today, the function should defend against a future
  // source that hands it a hostname.
  it.each([
    "127.0.0.1.evil.com",
    "fcebook.com",
    "fd.example.com",
    "10.0.0.1.attacker",
  ])("ignores X-Forwarded-For for non-IP hostname-shaped source (%s)", (addr) => {
    const socket = mockSocket(addr, {
      "x-forwarded-for": "198.51.100.42",
    });
    expect(getClientIp(socket)).toBe(addr);
  });

  it("returns first IP from multi-hop X-Forwarded-For", () => {
    const socket = mockSocket("127.0.0.1", {
      "x-forwarded-for": "203.0.113.50, 10.0.0.1, 172.16.0.1",
    });
    expect(getClientIp(socket)).toBe("203.0.113.50");
  });

  it("trims whitespace from X-Forwarded-For entries", () => {
    const socket = mockSocket("127.0.0.1", {
      "x-forwarded-for": "  203.0.113.50  , 10.0.0.1",
    });
    expect(getClientIp(socket)).toBe("203.0.113.50");
  });

  it("falls back to loopback when X-Forwarded-For is missing", () => {
    const socket = mockSocket("127.0.0.1", {});
    expect(getClientIp(socket)).toBe("127.0.0.1");
  });

  it("falls back to loopback when X-Forwarded-For is empty string", () => {
    const socket = mockSocket("::1", {
      "x-forwarded-for": "",
    });
    expect(getClientIp(socket)).toBe("::1");
  });

  it('returns "unknown" when address is empty', () => {
    const socket = mockSocket("", {});
    expect(getClientIp(socket)).toBe("unknown");
  });
});

describe("cancelAllPendingDisconnects", () => {
  afterEach(() => {
    cancelAllPendingDisconnects();
    setDisconnectGraceMs(null);
  });

  it("clears every pending disconnect so its callback never runs", async () => {
    setDisconnectGraceMs(50);
    let fired = 0;
    schedulePendingDisconnect("p1", () => {
      fired++;
    });
    schedulePendingDisconnect("p2", () => {
      fired++;
    });
    expect(hasPendingDisconnect("p1")).toBe(true);
    expect(hasPendingDisconnect("p2")).toBe(true);

    const cleared = cancelAllPendingDisconnects();
    expect(cleared).toBe(2);
    expect(hasPendingDisconnect("p1")).toBe(false);
    expect(hasPendingDisconnect("p2")).toBe(false);

    // Wait past the grace window to confirm neither callback ran.
    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(0);
  });

  it("returns 0 when nothing is pending", () => {
    expect(cancelAllPendingDisconnects()).toBe(0);
  });
});
