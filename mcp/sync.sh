#!/usr/bin/env bash
# Sync MCP servers from this repo into the runtime locations Augment launches,
# then re-register them with auggie. Idempotent — safe to re-run.
#
# Run from anywhere; paths are absolute.

set -euo pipefail

REPO_DIR="/Users/imihai/repos/personal/collabmd"
TOOLS_DIR="$HOME/.augment/tools"
UV="/opt/homebrew/bin/uv"
COLLABMD_URL="${COLLABMD_URL:-http://localhost:1317}"

if [ ! -x "$UV" ]; then
  echo "error: uv not found at $UV" >&2
  exit 1
fi

if ! command -v auggie >/dev/null 2>&1; then
  echo "error: auggie not on PATH" >&2
  exit 1
fi

sync_server() {
  local name="$1"
  local src="$REPO_DIR/mcp/$name/server.py"
  local dst="$TOOLS_DIR/$name/server.py"

  if [ ! -f "$src" ]; then
    echo "error: $src not found" >&2
    exit 1
  fi

  mkdir -p "$TOOLS_DIR/$name"
  cp "$src" "$dst"
  chmod +x "$dst"
  echo "synced $name → $dst"
}

register_review() {
  auggie mcp add-json collabmd-review "{\"command\":\"$UV\",\"args\":[\"run\",\"--script\",\"$TOOLS_DIR/collabmd-review/server.py\"],\"env\":{\"COLLABMD_URL\":\"$COLLABMD_URL\"}}" >/dev/null 2>&1 || true
  echo "registered collabmd-review (COLLABMD_URL=$COLLABMD_URL)"
}

register_wait() {
  auggie mcp add-json agent-wait "{\"command\":\"$UV\",\"args\":[\"run\",\"--script\",\"$TOOLS_DIR/agent-wait/server.py\"]}" >/dev/null 2>&1 || true
  echo "registered agent-wait"
}

sync_server collabmd-review
sync_server agent-wait
register_review
register_wait

echo
echo "done. verify with: auggie mcp list"
