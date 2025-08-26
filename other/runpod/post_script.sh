#!/usr/bin/env bash
set -Eeuo pipefail

PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/main/other/runpod/prepare_comfy.py"
PY_DEST="$(mktemp /tmp/prepare_comfy.XXXXXX.py)"

curl -fsSL "$PY_URL" -o "$PY_DEST"
sed -i 's/\r$//' "$PY_DEST"   # normalize line endings just in case

# Replace the shell with Python so exit code is from the script
exec python3 -u "$PY_DEST" "$@"
