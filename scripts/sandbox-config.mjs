/**
 * Sandbox configuration helpers.
 * Pure functions with no side effects — fully testable.
 */

/**
 * Ports that sandboxes may not use. 443 is owned by the admin-panel
 * Tailscale serve rule (see scripts/ensure-admin-tailscale-serve.sh); using
 * it for a sandbox would wipe admin access the moment the sandbox is torn
 * down.
 */
export const RESERVED_SANDBOX_PORTS = new Set(["443"]);

/**
 * Thrown when a caller asks for a sandbox config on a reserved port.
 */
export class ReservedPortError extends Error {
  /** @param {string} port */
  constructor(port) {
    super(
      `Port ${port} is reserved (admin-panel Tailscale serve rule). ` +
        `Pick a different SANDBOX_PORT.`,
    );
    this.name = "ReservedPortError";
    this.port = port;
  }
}

/**
 * Build sandbox config from environment variables.
 * @param {Record<string, string | undefined>} env - Environment variables
 * @returns {{ port: string, tailscale: boolean, bind: string, portMapping: string }}
 * @throws {ReservedPortError} when SANDBOX_PORT is a reserved port
 */
export function getSandboxConfig(env = process.env) {
  const port = env.SANDBOX_PORT || "3002";
  if (RESERVED_SANDBOX_PORTS.has(port)) {
    throw new ReservedPortError(port);
  }
  const tailscale = env.SANDBOX_TAILSCALE !== "0";
  const bind = tailscale ? "127.0.0.1" : "0.0.0.0";
  const portMapping = `${bind}:${port}:3001`;
  return { port, tailscale, bind, portMapping };
}

/**
 * Build the Tailscale HTTPS URL for a sandbox port.
 * @param {string} port - The sandbox port
 * @param {string} hostname - Tailscale DNSName (may have trailing dot)
 * @returns {string} Full HTTPS URL
 */
export function getTailscaleUrl(port, hostname) {
  const clean = hostname.replace(/\.$/, "");
  return `https://${clean}:${port}/`;
}

/**
 * Args for `tailscale serve --bg --https=PORT http://localhost:PORT`.
 * @param {string} port
 * @returns {string[]}
 */
export function getTailscaleServeArgs(port) {
  return ["serve", "--bg", `--https=${port}`, `http://localhost:${port}`];
}

/**
 * Args for `tailscale serve --https=PORT off`.
 * @param {string} port
 * @returns {string[]}
 */
export function getTailscaleServeOffArgs(port) {
  return ["serve", `--https=${port}`, "off"];
}

/**
 * The URL to display after the sandbox is up.
 * @param {string} port
 * @param {boolean} tailscaleEnabled
 * @param {string} tailscaleHostname
 * @returns {string}
 */
export function getPublicUrl(port, tailscaleEnabled, tailscaleHostname) {
  if (tailscaleEnabled && tailscaleHostname) {
    return getTailscaleUrl(port, tailscaleHostname);
  }
  return port === "3002"
    ? "https://sandbox.price.games/"
    : `https://sandbox-${port}.price.games/`;
}
