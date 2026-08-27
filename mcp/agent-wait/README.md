# agent-wait MCP

Two tools for keeping the agentic loop alive without polling.

## Tools

### `wait(seconds, label="")`

Block for `seconds` seconds, then return. Use before checking a terminal
signal (pipeline status, health endpoint, pod count, etc.) when you have no
concrete condition to poll.

### `wait_for(condition, params, timeout_s, interval_s=2)`

Poll until a condition is met, then return. Use when you have a concrete
signal — avoids blind sleeps. Caps total wait at `timeout_s` so a session
never hangs indefinitely.

**Conditions:**

| condition     | params                                   | met when                       |
|---------------|------------------------------------------|--------------------------------|
| `http_healthy`| `{"url": "http://host/path"}`            | GET returns 2xx                |
| `port_open`   | `{"host": "127.0.0.1", "port": 1317}`    | TCP connect succeeds           |
| `file_exists` | `{"path": "/abs/path/to/file"}`          | `os.path.exists(path)` is true |

**Returns:** JSON `{"ok": bool, "elapsed_ms": int, "timed_out": bool}`.

## Usage patterns

```
# wait for a local server to come back after a restart
wait_for(condition="port_open", params={"host": "127.0.0.1", "port": 1317}, timeout_s=60)

# wait for an HTTP health endpoint
wait_for(condition="http_healthy", params={"url": "http://localhost:1317/api/health"}, timeout_s=30)

# wait for a build artifact to land
wait_for(condition="file_exists", params={"path": "/tmp/build-done.marker"}, timeout_s=120)
```

## Registration

This repo copy is the **single source of truth** — Augment launches the
script directly from here, so you only edit in one place. Register with
Augment (auggie CLI), replacing `<repo>` with your local checkout path:

```bash
auggie mcp add-json agent-wait '{
  "command": "<uv-path>",
  "args": ["run", "--script", "<repo>/mcp/agent-wait/server.py"]
}'

auggie mcp list
```

Or run `./mcp/register.sh` from the repo root, which resolves the paths
automatically.

If you previously registered the `~/.augment/tools/agent-wait/server.py`
copy, remove it first:

```bash
auggie mcp remove agent-wait
auggie mcp add-json agent-wait '{ … }'
```

No `cp` step — the script runs in place from `mcp/agent-wait/server.py`.

## Files

- `server.py` — the MCP server (uv inline script, deps: `mcp[cli]>=1.2,<2`, `httpx>=0.27`).
- `README.md` — this file.
