#!/usr/bin/env bash
# Register the CollabMD MCP servers with auggie so Augment launches them
# directly from this repo. Single source of truth — no copy into
# ~/.augment/tools/. Re-runnable; removes any stale registration first.
#
# Run from anywhere; repo dir and uv path are resolved dynamically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UV="$(command -v uv || true)"
COLLABMD_URL="${COLLABMD_URL:-http://localhost:1317}"

if [ -z "$UV" ]; then
  echo "error: uv not found on PATH" >&2
  exit 1
fi

if ! command -v auggie >/dev/null 2>&1; then
  echo "error: auggie not on PATH" >&2
  exit 1
fi

register_review() {
  auggie mcp remove collabmd-review >/dev/null 2>&1 || true
  auggie mcp add-json collabmd-review \
    "{\"command\":\"$UV\",\"args\":[\"run\",\"--script\",\"$REPO_DIR/mcp/collabmd-review/server.py\"],\"env\":{\"COLLABMD_URL\":\"$COLLABMD_URL\"}}" \
    >/dev/null 2>&1
  echo "registered collabmd-review → $REPO_DIR/mcp/collabmd-review/server.py (COLLABMD_URL=$COLLABMD_URL)"
}

register_wait() {
  auggie mcp remove agent-wait >/dev/null 2>&1 || true
  auggie mcp add-json agent-wait \
    "{\"command\":\"$UV\",\"args\":[\"run\",\"--script\",\"$REPO_DIR/mcp/agent-wait/server.py\"]}" \
    >/dev/null 2>&1
  echo "registered agent-wait → $REPO_DIR/mcp/agent-wait/server.py"
}

register_review
register_wait

echo
echo "done. verify with: auggie mcp list"
