#!/usr/bin/env bash
set -euo pipefail

# Ensure the admin-panel Tailscale serve rule is in place.
#
# The admin panel (/admin, /api/admin/*) is blocked at Caddy on the public
# domain and is only reachable via the Tailscale network. That access depends
# on a single `tailscale serve` rule: https (port 443) -> http://localhost:3001.
#
# This script is the single source of truth for that rule. It is idempotent:
#
#   - If the rule is already in place, it's a no-op (exit 0).
#   - If the rule is missing or points to the wrong backend, it restores it.
#
# Safe to run repeatedly. Designed to be invoked from:
#
#   1. The `price-game-admin-serve.service` systemd unit (on boot + via timer)
#   2. `scripts/sandbox.sh` after every up/down/rebuild (belt-and-suspenders)
#   3. Manually by an operator recovering from a misconfigured Tailscale state
#
# Requires: sudo, tailscale CLI, node (for JSON parsing).
#
# Exit codes:
#   0  rule present (already or after repair)
#   1  tailscale CLI missing or not reachable
#   2  repair attempted but verification failed

ADMIN_BACKEND="http://localhost:3001"
ADMIN_PORT="443"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "ensure-admin-tailscale-serve: tailscale CLI not found" >&2
  exit 1
fi

# Read current serve config and check whether the admin rule is healthy.
# We use node for JSON parsing because it's already required by the repo
# (sandbox.sh depends on it) and avoids a jq dependency.
check_rule_present() {
  sudo tailscale serve status --json 2>/dev/null | node -e "
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      let cfg;
      try { cfg = JSON.parse(raw); } catch { process.exit(1); }
      const web = cfg && cfg.Web;
      if (!web || typeof web !== 'object') { process.exit(1); }
      // The hostname key looks like 'ubuntu-8gb-hil-1.tail3174b6.ts.net:443'.
      // Match any entry ending with ':${ADMIN_PORT}' so the check is
      // hostname-agnostic across environments.
      const suffix = ':${ADMIN_PORT}';
      const entry = Object.entries(web).find(([k]) => k.endsWith(suffix));
      if (!entry) { process.exit(1); }
      const proxy = entry[1] && entry[1].Handlers && entry[1].Handlers['/']
        && entry[1].Handlers['/'].Proxy;
      if (proxy !== '${ADMIN_BACKEND}') { process.exit(1); }
      process.exit(0);
    });
  "
}

if check_rule_present; then
  echo "ensure-admin-tailscale-serve: rule already in place (${ADMIN_BACKEND} on :${ADMIN_PORT})"
  exit 0
fi

echo "ensure-admin-tailscale-serve: restoring rule (${ADMIN_BACKEND} on :${ADMIN_PORT})" >&2
sudo tailscale serve --bg "--https=${ADMIN_PORT}" "${ADMIN_BACKEND}" >&2

# Verify the repair landed. Tailscale serve is synchronous, but the JSON
# state file takes a moment to flush in some versions.
if check_rule_present; then
  echo "ensure-admin-tailscale-serve: rule restored"
  exit 0
fi

echo "ensure-admin-tailscale-serve: repair attempted but verification failed" >&2
exit 2
