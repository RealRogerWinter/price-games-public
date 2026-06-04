#!/usr/bin/env bash
# Streamer image build + push helper.
#
# Builds `infra/streamer/Dockerfile` from the current checkout,
# tags it as the operator-facing ghcr.io image (matching what
# `docker-compose.prod.yml` consumes), and pushes to GitHub
# Container Registry. The streamer container is deployed on a
# SEPARATE host (`onestreamer` on the tailnet) — this script does
# not restart any running container; after push, the operator
# runs the pull + up on that host. Output ends with the exact
# commands to run.
#
# Why this exists: `infra/streamer/Dockerfile` is built and tagged
# out-of-band — there is no CI hook that rebuilds it when
# `packages/bot-streamer/` changes. Operators previously cobbled
# together the build/tag/push from the README's example, which was
# error-prone (drifted org prefix between developers) and forgot
# the multi-arch flag. This script standardises the procedure.
#
# Requirements:
#   - Docker Engine + buildx
#   - `docker login ghcr.io` already done (token in ~/.docker/config.json)
#   - Run from any clean checkout of the repo (uses repo root for build context)
#
# Usage:
#   scripts/streamer-redeploy.sh                      # build + push :latest
#   STREAMER_IMAGE_TAG=v2026-05-08 scripts/...        # custom tag (immutable point-in-time)
#   STREAMER_PUSH=0 scripts/...                       # build only, skip push
#
# Environment overrides:
#   DOCKER_IMAGE_NAME    Org/repo prefix on ghcr.io (default: onestreamer/price-game)
#   STREAMER_IMAGE_TAG   Image tag (default: latest)
#   STREAMER_PLATFORM    Build platform (default: linux/amd64; the streamer
#                        host is amd64 — building arm64 wastes minutes)
#   STREAMER_PUSH        1 to push, 0 to build-only (default: 1)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOCKER_IMAGE_NAME="${DOCKER_IMAGE_NAME:-onestreamer/price-game}"
STREAMER_IMAGE_TAG="${STREAMER_IMAGE_TAG:-latest}"
STREAMER_PLATFORM="${STREAMER_PLATFORM:-linux/amd64}"
STREAMER_PUSH="${STREAMER_PUSH:-1}"

IMAGE_REF="ghcr.io/${DOCKER_IMAGE_NAME}-streamer:${STREAMER_IMAGE_TAG}"
# Derive the OCI source label from the same org prefix so a fork
# (DOCKER_IMAGE_NAME=myorg/price-game) doesn't end up with a label
# pointing at the upstream repo.
SOURCE_LABEL_URL="${SOURCE_LABEL_URL:-https://github.com/${DOCKER_IMAGE_NAME%-streamer}}"

log() { echo "[streamer-redeploy] $*" >&2; }

# Sanity: build context must be the repo root (Dockerfile assumes it).
if [ ! -f "$REPO_ROOT/infra/streamer/Dockerfile" ]; then
  log "FATAL: infra/streamer/Dockerfile not found at $REPO_ROOT — wrong checkout?"
  exit 1
fi

# Pre-flight: when pushing, require the operator to be logged in to
# ghcr.io. Without this the build runs to completion (~5 min) only to
# fail at the push step with a confusing "denied" error. Do a cheap
# token-lookup against the Docker credential store.
if [ "$STREAMER_PUSH" = "1" ]; then
  if ! docker info --format '{{json .RegistryConfig}}' >/dev/null 2>&1; then
    log "FATAL: docker daemon unreachable (is the engine running?)."
    exit 1
  fi
  if ! grep -q '"ghcr.io"' "$HOME/.docker/config.json" 2>/dev/null \
     && ! docker --config "$HOME/.docker" info 2>&1 | grep -q "ghcr.io"; then
    log "FATAL: ghcr.io credentials not found in ~/.docker/config.json."
    log "       Run \`docker login ghcr.io\` first, or set STREAMER_PUSH=0 to build only."
    exit 1
  fi
fi

# Sanity: detect uncommitted-or-untracked changes. `git diff --quiet HEAD`
# misses untracked files — and `COPY . .` in the Dockerfile would
# silently bake them into the image — so we use `git status --porcelain`
# as the dirty-tree predicate instead.
DIRTY=""
if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  DIRTY="1"
fi

# Versioned tags imply "snapshot of THIS commit"; refuse on a dirty
# tree because that snapshot is unrecoverable later. `latest` is the
# operator's normal flow — a dirty tree is allowed there but emits a
# warning so an accidental "credentials.json" sitting in the
# build context can't slip into a production image silently.
if [ "$STREAMER_IMAGE_TAG" != "latest" ] && [ -n "$DIRTY" ]; then
  log "FATAL: refusing to build versioned tag '$STREAMER_IMAGE_TAG' on dirty tree."
  log "       Commit / stash changes first, or use STREAMER_IMAGE_TAG=latest for ad-hoc builds."
  exit 1
fi
if [ "$STREAMER_IMAGE_TAG" = "latest" ] && [ -n "$DIRTY" ]; then
  log "WARNING: dirty tree — uncommitted / untracked changes will be baked into :latest."
  log "         Run 'git status' to inspect; image revision label still records the SHA."
fi

GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo "unknown")"
GIT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"

log "image:     $IMAGE_REF"
log "platform:  $STREAMER_PLATFORM"
log "git:       $GIT_BRANCH @ $GIT_SHA"
log "context:   $REPO_ROOT"
log "push:      $STREAMER_PUSH"

# --load is mutually exclusive with --push for buildx; pick one.
# Use an array so the flag expands as a single argv element under
# `set -u` + quoted expansion (defensive shellcheck SC2086).
if [ "$STREAMER_PUSH" = "1" ]; then
  BUILDX_OUTPUT=("--push")
else
  BUILDX_OUTPUT=("--load")
fi

log "starting buildx build (this is ~3-5 minutes uncached)…"
docker buildx build \
  --platform "$STREAMER_PLATFORM" \
  --file "$REPO_ROOT/infra/streamer/Dockerfile" \
  --tag "$IMAGE_REF" \
  --label "org.opencontainers.image.revision=$GIT_SHA" \
  --label "org.opencontainers.image.source=$SOURCE_LABEL_URL" \
  "${BUILDX_OUTPUT[@]}" \
  "$REPO_ROOT"

log ""
log "build complete: $IMAGE_REF"

if [ "$STREAMER_PUSH" = "1" ]; then
  log ""
  log "image pushed. To deploy on the streamer host, run the commands below."
  log ""
  # Print the operator-facing commands on STDOUT (not stderr) so the
  # block can be `tee`d / grep'd / piped into a clipboard tool. log()
  # goes to stderr; this block intentionally bypasses it.
  cat <<EOF
ssh <streamer-host>
cd <repo-checkout>
sudo docker compose -f docker-compose.prod.yml --profile streamer pull streamer
sudo docker compose -f docker-compose.prod.yml --profile streamer up -d streamer
sudo docker logs -f --tail=50 \$(sudo docker compose -f docker-compose.prod.yml --profile streamer ps -q streamer)
EOF
else
  log "skipping push (STREAMER_PUSH=0). Local image only."
fi
