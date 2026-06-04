import { describe, it, expect } from "vitest";
import {
  getSandboxConfig,
  getTailscaleUrl,
  getTailscaleServeArgs,
  getTailscaleServeOffArgs,
  getPublicUrl,
  RESERVED_SANDBOX_PORTS,
  ReservedPortError,
} from "./sandbox-config.mjs";

describe("getSandboxConfig", () => {
  it("defaults to port 3002", () => {
    const config = getSandboxConfig({});
    expect(config.port).toBe("3002");
  });

  it("enables tailscale by default when SANDBOX_TAILSCALE is unset", () => {
    const config = getSandboxConfig({});
    expect(config.tailscale).toBe(true);
  });

  it("binds to 127.0.0.1 when tailscale is enabled", () => {
    const config = getSandboxConfig({});
    expect(config.bind).toBe("127.0.0.1");
  });

  it("binds to 0.0.0.0 when tailscale is disabled", () => {
    const config = getSandboxConfig({ SANDBOX_TAILSCALE: "0" });
    expect(config.bind).toBe("0.0.0.0");
  });

  it("returns the correct docker compose port mapping", () => {
    const config = getSandboxConfig({});
    expect(config.portMapping).toBe("127.0.0.1:3002:3001");
  });

  it("uses SANDBOX_PORT from env", () => {
    const config = getSandboxConfig({ SANDBOX_PORT: "3003" });
    expect(config.port).toBe("3003");
    expect(config.portMapping).toBe("127.0.0.1:3003:3001");
  });

  it("disables tailscale when SANDBOX_TAILSCALE=0", () => {
    const config = getSandboxConfig({ SANDBOX_TAILSCALE: "0" });
    expect(config.tailscale).toBe(false);
    expect(config.bind).toBe("0.0.0.0");
    expect(config.portMapping).toBe("0.0.0.0:3002:3001");
  });

  it("enables tailscale when SANDBOX_TAILSCALE=1", () => {
    const config = getSandboxConfig({ SANDBOX_TAILSCALE: "1" });
    expect(config.tailscale).toBe(true);
  });

  it("rejects reserved port 443 (admin Tailscale serve rule)", () => {
    expect(() => getSandboxConfig({ SANDBOX_PORT: "443" })).toThrow(
      ReservedPortError,
    );
    expect(() => getSandboxConfig({ SANDBOX_PORT: "443" })).toThrow(
      /reserved/i,
    );
  });

  it("lists 443 in RESERVED_SANDBOX_PORTS", () => {
    expect(RESERVED_SANDBOX_PORTS.has("443")).toBe(true);
  });
});

describe("getTailscaleUrl", () => {
  it("builds correct HTTPS URL with port", () => {
    expect(getTailscaleUrl("3002", "myhost.tail1234.ts.net")).toBe(
      "https://myhost.tail1234.ts.net:3002/"
    );
  });

  it("strips trailing dot from DNSName", () => {
    expect(getTailscaleUrl("3002", "myhost.tail1234.ts.net.")).toBe(
      "https://myhost.tail1234.ts.net:3002/"
    );
  });
});

describe("getTailscaleServeArgs", () => {
  it("returns correct serve command args", () => {
    expect(getTailscaleServeArgs("3002")).toEqual([
      "serve",
      "--bg",
      "--https=3002",
      "http://localhost:3002",
    ]);
  });
});

describe("getTailscaleServeOffArgs", () => {
  it("returns correct serve-off command args", () => {
    expect(getTailscaleServeOffArgs("3002")).toEqual([
      "serve",
      "--https=3002",
      "off",
    ]);
  });
});

describe("getPublicUrl", () => {
  it("returns tailscale URL when enabled", () => {
    expect(getPublicUrl("3002", true, "myhost.tail1234.ts.net")).toBe(
      "https://myhost.tail1234.ts.net:3002/"
    );
  });

  it("returns sandbox.price.games for port 3002 when disabled", () => {
    expect(getPublicUrl("3002", false, "")).toBe(
      "https://sandbox.price.games/"
    );
  });

  it("returns sandbox-PORT.price.games for other ports when disabled", () => {
    expect(getPublicUrl("3003", false, "")).toBe(
      "https://sandbox-3003.price.games/"
    );
  });
});
