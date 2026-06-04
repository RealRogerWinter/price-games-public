#!/usr/bin/env bash
# PreToolUse Bash hook: block image-generation CLI calls whose --output
# path is outside the project's image archive.
#
# Fires on any Bash command mentioning cli.bundle.js / media-pipeline /
# image-generation. Exits 2 (blocking error) with an actionable message
# on stderr if the command's output path does not live under the image
# archive ($IMAGE_ARCHIVE_ROOT, default $HOME/image-archive). Exits 0
# (allow) otherwise.
set -euo pipefail

# Archive root the gallery scans; keep in sync with assetArchive.ts.
archive_root="${IMAGE_ARCHIVE_ROOT:-$HOME/image-archive}"
archive_images="$archive_root/images"

# Extract the tool_input.command string from the stdin JSON payload via
# python3 (jq is not guaranteed to be installed on this host).
cmd=$(python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")')

# Only engage on commands that invoke the image-generation CLI.
if ! grep -qE 'cli\.bundle\.js|media-pipeline|image-generation' <<<"$cmd"; then
  exit 0
fi

# Extract the --output / -o argument value. Handles both
# "--output path" and "--output=path" (and -o variants).
out=$(grep -oE -- '(--output|-o)([= ])[^ ]+' <<<"$cmd" | head -1 | sed -E 's/^(--output|-o)[= ]//')
# Strip surrounding single or double quotes if present.
out="${out%\"}"
out="${out#\"}"
out="${out%\'}"
out="${out#\'}"

if [[ -z "$out" || "$out" != "$archive_images"/* ]]; then
  cat >&2 <<EOF
BLOCKED: image-generation must save to $archive_images/<namespace>/<slug>.png.
  Detected --output: ${out:-<missing>}
Fix:
  1. Rerun with --output $archive_images/<namespace>/<slug>.png
     (pick a descriptive namespace dir and a kebab-case slug).
  2. Immediately write a matching sidecar JSON at the same basename with
     .json extension, containing { title, category, tags, prompt, model,
     aspectRatio, createdAt, source }. Schema in CLAUDE.md § "Image Assets".
  3. The admin gallery at /admin/gallery will then surface it on refresh.
EOF
  exit 2
fi

exit 0
