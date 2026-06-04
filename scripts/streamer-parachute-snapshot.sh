#!/bin/bash
# Phase 3d.2 parachute snapshot — copies the streamer container's
# learning.db onto the host as `learning.db.parachute-pre-3d2` BEFORE
# a new image goes live. Idempotent — re-running overwrites the
# existing parachute file.
#
# Why: the schema bump (HEAD_TOPOLOGY_VERSION 1 → 2) auto-archives
# the snapshot via the existing archHash-mismatch path. That archive
# lives inside the container's volume, but a deploy that crashes
# mid-init can corrupt either the live or the archived snapshot.
# A filesystem copy on the host gives us a guaranteed-recoverable
# point to restore from if the rollback procedure (see PLAN.md §9)
# triggers.
#
# Usage:
#   sudo ./scripts/streamer-parachute-snapshot.sh
#
# Environment:
#   STREAMER_CONTAINER  Container name (default: price-game_streamer_1)
#   PARACHUTE_PATH      Host path for the copy (default:
#                       $HOME/learning.db.parachute-pre-3d2)
set -euo pipefail
# Security review LOW finding: harden the parachute file mode so a
# concurrent sudo user can't read the on-disk DB. NN weights aren't
# credentials, but the WAL/SHM siblings can leak transient training
# state during a recovery.
umask 077

CONTAINER="${STREAMER_CONTAINER:-price-game_streamer_1}"
PARACHUTE_PATH="${PARACHUTE_PATH:-$HOME/learning.db.parachute-pre-3d2}"
SOURCE_PATH="/var/streamer/data/learning.db"

if ! command -v docker >/dev/null 2>&1; then
  echo "[parachute] docker CLI not found — abort" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "[parachute] container '$CONTAINER' is not running — abort" >&2
  exit 1
fi

# Use docker cp to pull the file out. The container has a checkpoint
# style writer so even a copy taken mid-update should be a complete
# WAL-consistent snapshot — sqlite's WAL means readers see a coherent
# DB at any moment.
echo "[parachute] copying $CONTAINER:$SOURCE_PATH → $PARACHUTE_PATH"
docker cp "$CONTAINER:$SOURCE_PATH" "$PARACHUTE_PATH"

# Also grab the WAL + SHM if they exist, so a full restore via
# sqlite is possible.
for ext in "-wal" "-shm"; do
  if docker exec "$CONTAINER" test -f "${SOURCE_PATH}${ext}" 2>/dev/null; then
    docker cp "$CONTAINER:${SOURCE_PATH}${ext}" "${PARACHUTE_PATH}${ext}"
    echo "[parachute] copied ${SOURCE_PATH}${ext} → ${PARACHUTE_PATH}${ext}"
  fi
done

chmod 600 "$PARACHUTE_PATH"* 2>/dev/null || true
ls -lh "$PARACHUTE_PATH"*
echo "[parachute] done. To restore:"
echo "  docker cp $PARACHUTE_PATH $CONTAINER:$SOURCE_PATH"
echo "  docker restart $CONTAINER"
