#!/usr/bin/env bash
# Streamer container entrypoint. Boots the four daemons that make up
# the stream pipeline, then exec's into the bot-streamer Node runner
# (which drives Chromium via Playwright).
#
# Daemon supervision: tini reaps zombies at PID 1; this script `wait -n`s
# on every daemon's PID and exits non-zero if any of them dies, so
# Docker's restart policy gives us a fresh container. The previous
# "downstream consumers will notice" assumption was wrong for Xvfb
# specifically — the runner kept running with DISPLAY pointing at a
# dead X server and every Playwright launch failed forever.

set -euo pipefail

WIDTH="${STREAMER_WIDTH:-1920}"
HEIGHT="${STREAMER_HEIGHT:-1080}"
FPS="${STREAMER_FPS:-30}"
BITRATE_KBPS="${STREAMER_BITRATE_KBPS:-4500}"
DISPLAY_NUM="${DISPLAY_NUM:-100}"

log() {
  echo "[streamer-entrypoint] $*" >&2
}

# 1. Xvfb — virtual X display.
log "starting Xvfb on :${DISPLAY_NUM} at ${WIDTH}x${HEIGHT}"
# Clear stale socket + lock from a previous container run on the same
# writable layer (e.g. across `docker restart`). If either survives,
# Xvfb refuses to bind with "Fatal server error" and exits silently —
# leaving the runner alive but every Playwright launch broken because
# DISPLAY points at a dead server.
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
Xvfb ":${DISPLAY_NUM}" -screen 0 "${WIDTH}x${HEIGHT}x24" &
XVFB_PID=$!
export DISPLAY=":${DISPLAY_NUM}"

# Block until the X server is actually answering before starting any
# downstream daemon. Without this gate ffmpeg's x11grab and Playwright
# both race Xvfb and intermittently attach to a half-up display. If
# Xvfb fails to come up within 10s we exit non-zero so Docker's
# restart policy retries with a fresh container.
for _ in $(seq 1 100); do
  if xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
    log "FATAL: Xvfb exited during startup"
    exit 1
  fi
  sleep 0.1
done
if ! xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1; then
  log "FATAL: Xvfb did not become ready within 10s"
  kill "${XVFB_PID}" 2>/dev/null || true
  exit 1
fi
log "Xvfb is ready on :${DISPLAY_NUM}"

# 2. PulseAudio — virtual sink for music + TTS, ffmpeg captures the monitor.
log "starting Pulseaudio (default.pa)"
pulseaudio --daemonize=no --exit-idle-time=-1 --file=/etc/streamer/pulse-default.pa &
PULSE_PID=$!

# 3. nginx-rtmp — fan-out RTMP from local port 1935 to YouTube/Twitch/Kick.
#    Render the config from the template via envsubst; empty stream
#    keys produce no `push` line.
log "rendering nginx-rtmp config"
YT_PUSH=""
TWITCH_PUSH=""
KICK_PUSH=""
[ -n "${STREAMER_YOUTUBE_KEY:-}" ] && YT_PUSH="push rtmp://a.rtmp.youtube.com/live2/${STREAMER_YOUTUBE_KEY};"
[ -n "${STREAMER_TWITCH_KEY:-}" ]  && TWITCH_PUSH="push rtmp://live.twitch.tv/app/${STREAMER_TWITCH_KEY};"
[ -n "${STREAMER_KICK_KEY:-}" ]    && KICK_PUSH="push rtmp://${STREAMER_KICK_RTMP_HOST:-fa723fc1b171.global-contribute.live-video.net}/${STREAMER_KICK_KEY};"

export YT_PUSH TWITCH_PUSH KICK_PUSH
envsubst '${YT_PUSH} ${TWITCH_PUSH} ${KICK_PUSH}' < /etc/streamer/nginx-rtmp.conf.tmpl > /tmp/nginx-rtmp.conf

log "starting nginx-rtmp"
nginx -c /tmp/nginx-rtmp.conf -e stderr &
NGINX_PID=$!

# 4. mpd — music daemon (queues music files into the broadcast sink).
#    Skipped if the music dir is empty so a freshly-deployed container
#    doesn't spam errors before the operator drops files in.
if [ -n "$(ls -A "${STREAMER_MUSIC_DIR:-/var/streamer/music}" 2>/dev/null)" ]; then
  log "starting mpd"
  mpd --no-daemon /etc/streamer/mpd.conf &
  MPD_PID=$!
fi

# 5. ffmpeg — captures Xvfb + Pulse, encodes x264, pushes to nginx-rtmp.
log "starting ffmpeg encoder (${WIDTH}x${HEIGHT}@${FPS}, ${BITRATE_KBPS}kbps)"
# thread_queue_size is bumped well past ffmpeg's default (8) so the
# x11grab + pulse pipelines can buffer frames while the encoder
# catches up. The default queue overflows under load and the
# encoder drops frames — the symptom is a laggy / stuttering stream.
ffmpeg -hide_banner -loglevel warning \
  -thread_queue_size 1024 -f x11grab -framerate "${FPS}" -video_size "${WIDTH}x${HEIGHT}" -i ":${DISPLAY_NUM}.0" \
  -thread_queue_size 1024 -f pulse -i broadcast.monitor \
  -c:v libx264 -preset veryfast -tune zerolatency \
    -b:v "${BITRATE_KBPS}k" -maxrate "${BITRATE_KBPS}k" -bufsize "$((BITRATE_KBPS * 2))k" \
    -pix_fmt yuv420p -g "$((FPS * 2))" -keyint_min "$((FPS * 2))" -sc_threshold 0 \
  -c:a aac -b:a 160k -ar 44100 -ac 2 \
  -f flv rtmp://127.0.0.1:1935/live/main &
FFMPEG_PID=$!

# Trap signals so a `docker stop` cascades to everything. RUNNER_PID is
# included now (the original list omitted it, so the runner only died
# at the docker-stop SIGKILL grace period). Exit explicitly from the
# trap so signal-driven shutdown doesn't fall through into the
# supervisor wait below.
#
# Shutdown is *bounded*: ffmpeg has been observed spinning in x11grab
# against a dead (OOM-killed) Xvfb, and the runner can stall in
# Playwright trying to close a browser whose X server has vanished.
# With an unbounded `wait` the entrypoint never returns, tini stays
# alive, the container reports "Up (unhealthy)" indefinitely and
# Docker's restart policy never fires — which is exactly how we
# wedged in prod. Cap the grace period (default 8s, well under
# compose's stop_grace_period: 30s) and then SIGKILL any holdouts.
CLEANUP_GRACE_SECONDS="${CLEANUP_GRACE_SECONDS:-8}"
_CLEANUP_RAN=0
cleanup() {
  # Idempotency guard: TERM+INT can race (or one can arrive while
  # cleanup is mid-flight) and bash will re-enter. A second pass would
  # background another SIGKILL timer — harmless but noisy.
  [ "${_CLEANUP_RAN}" = "1" ] && return
  _CLEANUP_RAN=1
  log "shutting down"
  local pids=()
  for pid in "${RUNNER_PID:-}" "${FFMPEG_PID:-}" "${NGINX_PID:-}" "${MPD_PID:-}" "${PULSE_PID:-}" "${XVFB_PID:-}"; do
    [ -n "${pid}" ] && pids+=("${pid}")
  done
  if [ "${#pids[@]}" -eq 0 ]; then
    return
  fi
  kill "${pids[@]}" 2>/dev/null || true
  # Fire-and-forget SIGKILL deadline. If every child handles SIGTERM
  # before the timer fires, the kill is a no-op against already-exited
  # pids. If a child hangs, the SIGKILL unblocks our `wait` on it.
  # We deliberately do NOT `wait` on this timer: it isn't in our wait
  # set, so the happy path (everyone exits cleanly in <8s) returns
  # immediately instead of paying the full grace period. When the
  # entrypoint exits, tini (PID 1, no `-g`) exits with its direct
  # child and the kernel SIGKILLs the timer along with everything
  # else in the container's PID namespace — it cannot outlive us.
  ( sleep "${CLEANUP_GRACE_SECONDS}"; kill -KILL "${pids[@]}" 2>/dev/null || true ) &
  for pid in "${pids[@]}"; do
    wait "${pid}" 2>/dev/null || true
  done
}
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 130' INT

# Phase 3e.0: install the golden-eval seed into the writable data dir
# if it isn't already present. Source is read-only at /etc/streamer/
# (baked into the image); destination is at $STREAMER_LEARNING_DATA_DIR/
# (compose-mounted volume). An operator can hand-edit / replace the
# runtime file and the seed install won't clobber it across restarts.
DATA_DIR="${STREAMER_LEARNING_DATA_DIR:-/var/streamer/data}"
GOLDEN_SRC="/etc/streamer/golden-eval.json"
GOLDEN_DST="${DATA_DIR}/golden-eval.json"
if [ -f "${GOLDEN_SRC}" ] && [ ! -f "${GOLDEN_DST}" ]; then
  mkdir -p "${DATA_DIR}"
  cp "${GOLDEN_SRC}" "${GOLDEN_DST}"
  log "installed golden-eval seed: ${GOLDEN_DST}"
fi

# 6. Bot runner — drives Playwright + observer + chat. Started in the
#    background so the cleanup trap above stays attached to *this*
#    shell as PID 1's child; when the runner exits we tear the rest
#    down explicitly. (Earlier versions used `exec`, which replaced the
#    shell with the node process and orphaned ffmpeg/nginx/Pulse/Xvfb
#    on `docker stop` because tini only signals its direct child.)
log "starting bot runner"
node /app/packages/bot-streamer/dist/runner/main.js &
RUNNER_PID=$!

# Supervise every daemon the stream depends on. ANY of them dying is
# fatal — Xvfb blanks the display, Pulse silences audio, nginx drops
# the rtmp fan-out, ffmpeg stops the encoder, mpd stops music. None of
# these can be recovered from in-place: tear the container down so
# Docker's restart policy gives us a fresh stack. The runner is in the
# wait set too so its normal exit (or crash) shuts us down cleanly.
SUPERVISED=(
  "${RUNNER_PID}:runner"
  "${XVFB_PID}:Xvfb"
  "${PULSE_PID}:Pulseaudio"
  "${NGINX_PID}:nginx"
  "${FFMPEG_PID}:ffmpeg"
)
# mpd is conditional — only added if the music dir was non-empty above.
[ -n "${MPD_PID:-}" ] && SUPERVISED+=("${MPD_PID}:mpd")

PIDS=()
for entry in "${SUPERVISED[@]}"; do
  PIDS+=("${entry%%:*}")
done

# `wait -n -p VAR` (bash 5.1+, bookworm ships 5.2) returns the exit
# status of whichever listed PID exits first AND stores its PID in VAR
# so we can map back to a daemon name for the log.
DIED_PID=""
WAIT_RC=0
wait -n -p DIED_PID "${PIDS[@]}" || WAIT_RC=$?

DEAD_NAME=""
for entry in "${SUPERVISED[@]}"; do
  if [ "${entry%%:*}" = "${DIED_PID}" ]; then
    DEAD_NAME="${entry##*:}"
    break
  fi
done

if [ -n "${DEAD_NAME}" ] && [ "${DEAD_NAME}" != "runner" ]; then
  log "FATAL: ${DEAD_NAME} died (pid=${DIED_PID}, rc=${WAIT_RC}) — exiting so Docker restarts the container"
  cleanup
  exit 1
fi

cleanup
exit "${WAIT_RC}"
