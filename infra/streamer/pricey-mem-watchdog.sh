#!/usr/bin/env bash
# Pre-emptively recycle the Pricey streamer container before it reaches
# its cgroup memory cap, so a slow Chromium/X11 leak triggers a *graceful*
# restart (mood persists across restarts via the server's mood_json)
# instead of a hard cgroup OOM-kill of Xvfb (which leaves the encoder a
# zombie publishing a black frame).
#
# Install on the host:
#   sudo cp infra/streamer/pricey-mem-watchdog.sh /usr/local/bin/
#   sudo chmod 755 /usr/local/bin/pricey-mem-watchdog.sh
#   sudo cp infra/streamer/pricey-mem-watchdog.{service,timer} /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now pricey-mem-watchdog.timer
#
# Tunables (env):
#   PRICEY_CONTAINER      Override container name/id. Default: resolve by
#                         compose label — robust to the v1 `_` vs v2 `-`
#                         container-naming difference.
#   PRICEY_MEM_TRIP_BYTES Restart threshold in bytes (default 5 GiB; the
#                         container cap is 6 GiB).
set -uo pipefail

CONTAINER="${PRICEY_CONTAINER:-}"
if [ -z "$CONTAINER" ]; then
  CONTAINER="$(docker ps -q \
    --filter label=com.docker.compose.project=price-game \
    --filter label=com.docker.compose.service=streamer | head -1)"
fi
[ -n "$CONTAINER" ] || { echo "watchdog: no running streamer container, skip"; exit 0; }

THRESHOLD_BYTES="${PRICEY_MEM_TRIP_BYTES:-$((5 * 1024 * 1024 * 1024))}"

CID="$(docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null)" || exit 0
[ -n "$CID" ] || exit 0
STATE="$(docker inspect -f '{{.State.Status}}' "$CID" 2>/dev/null)" || exit 0
[ "$STATE" = "running" ] || { echo "watchdog: state=$STATE, skip"; exit 0; }

CG="/sys/fs/cgroup/system.slice/docker-${CID}.scope/memory.current"
[ -r "$CG" ] || CG="$(find /sys/fs/cgroup -type d -name "docker-${CID}.scope" 2>/dev/null | head -1)/memory.current"
[ -r "$CG" ] || { echo "watchdog: cgroup memory.current unreadable, skip"; exit 0; }

CUR="$(cat "$CG")"; HUM=$((CUR / 1024 / 1024))
if [ "$CUR" -gt "$THRESHOLD_BYTES" ]; then
  echo "watchdog: mem=${HUM}MiB > $((THRESHOLD_BYTES / 1024 / 1024))MiB -> pre-emptive restart of ${CID:0:12}"
  docker restart "$CID" >/dev/null 2>&1 && echo "watchdog: restarted ${CID:0:12}" || echo "watchdog: restart FAILED"
else
  echo "watchdog: mem=${HUM}MiB ok"
fi
