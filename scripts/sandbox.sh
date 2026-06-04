#!/usr/bin/env bash
set -euo pipefail

# Sandbox lifecycle script.
#
# Usage:
#   scripts/sandbox.sh up        # build & start (default)
#   scripts/sandbox.sh down      # stop & teardown
#   scripts/sandbox.sh rebuild   # full rebuild (no cache)
#   scripts/sandbox.sh seed      # seed test products
#
# Environment:
#   SANDBOX_PORT       Host port (default: 3002)
#   SANDBOX_TAILSCALE  1=Tailscale only (default), 0=public via Caddy
#
# Reserved ports:
#   443 is reserved for the admin-panel Tailscale serve rule
#   (see scripts/ensure-admin-tailscale-serve.sh). This script will
#   refuse to operate on port 443 to prevent accidental takedown of
#   admin access.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT="${SANDBOX_PORT:-3002}"
TAILSCALE_ENABLED="${SANDBOX_TAILSCALE:-1}"

# Hard guardrail: port 443 belongs to the admin panel Tailscale serve rule.
# Refuse any sandbox operation that would touch it, so we can never again
# wipe admin access by fat-fingering a sandbox command.
if [ "$PORT" = "443" ]; then
  echo "sandbox: refusing to operate on port 443 — it is reserved for the" >&2
  echo "         admin-panel Tailscale serve rule. Pick a different" >&2
  echo "         SANDBOX_PORT (e.g. 3002, 3003, ...)." >&2
  exit 1
fi

if [ "$TAILSCALE_ENABLED" = "0" ]; then
  export SANDBOX_BIND="0.0.0.0"
else
  export SANDBOX_BIND="127.0.0.1"
fi

export SANDBOX_PORT="$PORT"

# Resolve the image-archive host dir here, in the unprivileged shell, where
# $HOME is the invoking user's home. The compose file's ${HOME} fallback would
# otherwise resolve under sudo (env_reset → HOME=/root) and mount the wrong
# directory. Honor an explicit IMAGE_ARCHIVE_HOST if the caller set one.
export IMAGE_ARCHIVE_HOST="${IMAGE_ARCHIVE_HOST:-$HOME/image-archive}"

# Preserve the shell env vars docker-compose.sandbox.yml relies on for
# variable substitution — plain `sudo` strips them by default, which would
# silently fall back to the compose-file defaults (SANDBOX_PORT=3002,
# SANDBOX_BIND=0.0.0.0) and make per-worktree ports impossible.
COMPOSE="sudo --preserve-env=SANDBOX_PORT,SANDBOX_BIND,IMAGE_ARCHIVE_HOST docker compose -f $PROJECT_DIR/docker-compose.sandbox.yml"

# Belt-and-suspenders: after every sandbox lifecycle operation, run the
# idempotent ensure-script so any unexpected state change in tailscale serve
# (our own or someone else's) doesn't leave admin access broken.
ensure_admin_serve() {
  if [ "$TAILSCALE_ENABLED" != "0" ]; then
    bash "$SCRIPT_DIR/ensure-admin-tailscale-serve.sh" || \
      echo "sandbox: warning — ensure-admin-tailscale-serve reported failure" >&2
  fi
}

get_tailscale_hostname() {
  sudo tailscale status --json | node -e "
    const j = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
    process.stdout.write(j.Self.DNSName.replace(/\\\.\$/, ''));
  "
}

print_url() {
  if [ "$TAILSCALE_ENABLED" != "0" ]; then
    local hostname
    hostname=$(get_tailscale_hostname)
    echo ""
    echo "  Sandbox available at: https://${hostname}:${PORT}/"
    echo ""
  else
    if [ "$PORT" = "3002" ]; then
      echo ""
      echo "  Sandbox available at: https://sandbox.price.games/"
      echo ""
    else
      echo ""
      echo "  Sandbox available at: https://sandbox-${PORT}.price.games/"
      echo ""
    fi
  fi
}

case "${1:-up}" in
  up)
    $COMPOSE up -d --build
    if [ "$TAILSCALE_ENABLED" != "0" ]; then
      sudo tailscale serve --bg --https="$PORT" "http://localhost:$PORT"
    fi
    ensure_admin_serve
    print_url
    ;;
  down)
    if [ "$TAILSCALE_ENABLED" != "0" ]; then
      sudo tailscale serve --https="$PORT" off 2>/dev/null || true
    fi
    $COMPOSE down
    ensure_admin_serve
    echo "Sandbox stopped."
    ;;
  rebuild)
    $COMPOSE up -d --build --no-cache
    if [ "$TAILSCALE_ENABLED" != "0" ]; then
      sudo tailscale serve --bg --https="$PORT" "http://localhost:$PORT"
    fi
    ensure_admin_serve
    print_url
    ;;
  seed)
    $COMPOSE cp "$PROJECT_DIR/scripts/sandbox-seed.js" app:/app/seed.js
    $COMPOSE exec app node /app/seed.js
    ;;
  *)
    echo "Usage: $0 {up|down|rebuild|seed}"
    exit 1
    ;;
esac
