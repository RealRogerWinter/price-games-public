#!/usr/bin/env bash
# nn-rollback.sh — restore the streamer-bot's NN to a snapshot taken at
# round R. Idempotent: rerunning leaves the new "current" snapshot
# pointing at R.
#
# The roll-forward path:
#   1. Locate the archived row (nn_snapshots_archived) at round R.
#   2. INSERT it back into nn_snapshots with the current timestamp.
#   3. Restart the streamer container so the worker reloads the latest
#      snapshot.
#
# Usage:
#   ./scripts/nn-rollback.sh <round>
#
# Requires a running `price-game-streamer-1` container with
# `/var/streamer/data/learning.db` mounted on the streamer-data volume.
set -euo pipefail

ROUND="${1:?usage: nn-rollback.sh <round>}"
CONTAINER="${STREAMER_CONTAINER:-price-game-streamer-1}"
DB_PATH="${STREAMER_DB_PATH:-/var/streamer/data/learning.db}"

# Validate the round arg as a non-negative integer before interpolating
# into SQL. Without this guard a malformed argument like
# "1; DROP TABLE nn_snapshots;--" would execute as two statements.
if ! [[ "${ROUND}" =~ ^[0-9]+$ ]]; then
  echo "nn-rollback: <round> must be a non-negative integer (got: ${ROUND})"
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "nn-rollback: container ${CONTAINER} is not running"
  exit 1
fi

# Verify the requested round exists in the archive.
EXISTS=$(docker exec "${CONTAINER}" sqlite3 "${DB_PATH}" \
  "SELECT count(*) FROM nn_snapshots_archived WHERE round = ${ROUND};")
if [[ "${EXISTS}" -lt 1 ]]; then
  echo "nn-rollback: no archived snapshot found at round ${ROUND}"
  echo "available archived rounds:"
  docker exec "${CONTAINER}" sqlite3 "${DB_PATH}" \
    "SELECT round, created_at FROM nn_snapshots_archived ORDER BY round DESC LIMIT 10;"
  exit 1
fi

docker exec "${CONTAINER}" sqlite3 "${DB_PATH}" \
  "INSERT INTO nn_snapshots (round, arch_hash, schema_version, weights, optimizer_state, feature_norm, replay_buffer, teaching_moments, ood_blender, uncertainty_weights, created_at)
   SELECT round, arch_hash, schema_version, weights, optimizer_state, feature_norm, replay_buffer, teaching_moments, ood_blender, uncertainty_weights, datetime('now')
   FROM nn_snapshots_archived WHERE round = ${ROUND} LIMIT 1;"

echo "nn-rollback: restored round ${ROUND}; restarting ${CONTAINER}"
docker restart "${CONTAINER}"
