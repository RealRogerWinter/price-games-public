#!/usr/bin/env bash
# PostToolUse Bash hook: after a successful image-generation CLI call,
# verify that a sidecar JSON file exists next to the output image. If
# it's missing, emit a non-blocking system reminder back to the model so
# it writes one before moving on.
#
# Never blocks — always exits 0. Only effect is an additionalContext
# payload injected via hookSpecificOutput when the sidecar is missing.
set -euo pipefail

cmd=$(python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")')

if ! grep -qE 'cli\.bundle\.js|media-pipeline|image-generation' <<<"$cmd"; then
  exit 0
fi

out=$(grep -oE -- '(--output|-o)([= ])[^ ]+' <<<"$cmd" | head -1 | sed -E 's/^(--output|-o)[= ]//')
out="${out%\"}"
out="${out#\"}"
out="${out%\'}"
out="${out#\'}"

# Nothing to check if we couldn't find an output path.
if [[ -z "$out" ]]; then
  exit 0
fi

# Sidecar = same basename with .json extension.
sidecar="${out%.*}.json"

if [[ -f "$sidecar" ]]; then
  exit 0
fi

# Inject a reminder into the model context via hookSpecificOutput.
# Printed to stdout as JSON; Claude Code parses this on PostToolUse.
python3 - "$sidecar" <<'PY'
import json, sys
sidecar = sys.argv[1]
msg = (
    f"Sidecar JSON missing at {sidecar}. Write it now with "
    "{ title, category, tags, prompt, model, aspectRatio, createdAt, source } "
    "fields — schema in CLAUDE.md § 'Image Assets'. Without a sidecar the "
    "gallery cannot categorize this asset and we lose generation provenance."
)
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": msg,
    }
}))
PY

exit 0
