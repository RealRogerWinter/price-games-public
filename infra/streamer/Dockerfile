# syntax=docker/dockerfile:1.6
# Streamer container — Xvfb + headed Chromium (Playwright) + Pulse +
# Piper TTS + ffmpeg + nginx-rtmp + the bot-streamer Node package.
#
# Built and tagged separately from the main app image. Compose pulls
# this one into the production stack alongside `app`.
#
# Image size note: Chromium + ffmpeg + Pulse + Xvfb adds ~600 MB.
# That's expected for a stream encoder; the alternative (running these
# on the host) leaks state and complicates ops.

FROM node:20.19-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# NODE_ENV is intentionally NOT set to "production" at this layer —
# `npm ci` skips devDependencies under NODE_ENV=production, but we
# need typescript / vitest (root devDeps) to build the workspaces
# below. The runtime layer at the bottom of the file pins NODE_ENV
# back to production after the build is done.

# Install system packages: Xvfb (virtual X display), Chromium (Playwright
# uses the system browser via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH),
# Pulseaudio + tools, mpd (music daemon), ffmpeg, nginx + nginx-rtmp,
# Piper TTS, alsa for the aplay binary, gettext for envsubst.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      chromium \
      fonts-noto-color-emoji fonts-liberation \
      pulseaudio \
      mpd mpc \
      ffmpeg \
      nginx libnginx-mod-rtmp \
      alsa-utils \
      ca-certificates \
      curl \
      gettext-base \
      tini \
      python3 make g++ libsqlite3-0 sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# better-sqlite3 ships native bindings; the build needs python3 + g++.
# Including sqlite3 in the runtime layer lets `scripts/nn-rollback.sh`
# query the DB without spawning a side container. The image is built
# `--platform=linux/amd64`; on Apple Silicon hosts a cross-build is
# required, otherwise the native bindings SIGABRT on first
# Database() call.

# Piper TTS binary (statically-linked release tarball).
ARG PIPER_VERSION=2023.11.14-2
RUN curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
      -o /tmp/piper.tar.gz \
    && mkdir -p /opt/piper \
    && tar -xzf /tmp/piper.tar.gz -C /opt/piper --strip-components=1 \
    && ln -s /opt/piper/piper /usr/local/bin/piper \
    && rm /tmp/piper.tar.gz

# Default voice model (en_US-amy-medium). Operators can mount a
# different model at runtime via STREAMER_TTS_VOICE_MODEL.
ARG VOICE_NAME=en_US-amy-medium
RUN mkdir -p /opt/voices \
    && curl -fsSL "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/${VOICE_NAME}.onnx" \
        -o "/opt/voices/${VOICE_NAME}.onnx" \
    && curl -fsSL "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/${VOICE_NAME}.onnx.json" \
        -o "/opt/voices/${VOICE_NAME}.onnx.json"

ENV STREAMER_TTS_VOICE_MODEL=/opt/voices/en_US-amy-medium.onnx \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    DISPLAY=:100

WORKDIR /app

# Copy the workspace skeleton first so npm ci can resolve workspaces.
# `package-lock.json` references every workspace; missing package.json
# files would cause npm ci to fail. Apps/server + apps/web + apps/
# extension are listed for that reason — their actual source isn't
# copied since the streamer image doesn't run them, but their
# manifests are needed for npm's workspace graph.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/bot-streamer/package.json ./packages/bot-streamer/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY apps/extension/package.json ./apps/extension/

# Install runtime + dev deps (vitest + tmi.js + playwright land here).
# We need playwright as a runtime dep at install time but the browser
# itself comes from the system Chromium above. Plain `npm ci`
# installs every workspace's deps so tsc + vitest are available for
# the build step below; constraining with --workspace flags omitted
# the root devDeps that the per-workspace build scripts depend on.
RUN npm ci

# Copy source last so changes there don't bust the npm cache layer.
COPY packages/shared ./packages/shared
COPY packages/bot-streamer ./packages/bot-streamer
COPY infra/streamer/entrypoint.sh /usr/local/bin/streamer-entrypoint
COPY infra/streamer/nginx-rtmp.conf.tmpl /etc/streamer/nginx-rtmp.conf.tmpl
COPY infra/streamer/mpd.conf /etc/streamer/mpd.conf
COPY infra/streamer/pulse-default.pa /etc/streamer/pulse-default.pa
# Phase 3e.0: golden-eval seed used by the snapshot regression gate.
# Read-only, version-controlled. Entrypoint copies into the writable
# data dir on boot when the runtime file is absent.
COPY infra/streamer/golden-eval.json /etc/streamer/golden-eval.json

RUN npm run build -w packages/shared \
    && npm run build -w packages/bot-streamer \
    && chmod +x /usr/local/bin/streamer-entrypoint

# Runtime env now that the build is done.
ENV NODE_ENV=production

# Pre-create /tmp/.X11-unix with the right perms so Xvfb (running as
# the unprivileged `node` user) can bind its socket. Without this
# Xvfb logs `euid != 0, directory /tmp/.X11-unix will not be created`
# and exits.
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# nginx's compiled-in default access_log + error_log paths live
# under /var/log/nginx; our config redirects error_log to stderr but
# nginx still tries to open the access_log default before the http
# block's `access_log off` takes effect. Make the dir writable by
# the runtime user. Same story for /var/lib/nginx where the working
# dirs (body, proxy, etc.) live by default — our config already
# redirects each *_temp_path into /tmp.
RUN chown -R node:node /var/log/nginx /var/lib/nginx

# Persistent state lives in /var/streamer (Chromium profile, mpd state,
# scratch). Compose mounts a named volume here.
RUN mkdir -p /var/streamer/profile /var/streamer/music /var/streamer/data \
    && chown -R node:node /var/streamer

USER node
EXPOSE 9101 9102

# tini reaps zombies (Chromium + ffmpeg + nginx all spawn children).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/streamer-entrypoint"]
