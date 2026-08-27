# MCP tools

Local stdio MCP servers used by the CollabMD agent loop. Each server is a
self-contained `uv` inline script (no venv, no install — `uv run --script`
resolves deps on first launch).

This directory is the **source of truth**. The runtime copies that Augment
launches live under `~/.augment/tools/<name>/server.py`. Sync from here:

```bash
./mcp/sync.sh        # copies both servers into ~/.augment/tools/ and re-registers
```

(or run the `cp` + `auggie mcp add-json` commands documented in each server's
README).

## Servers

| server            | path                          | tools                                   | purpose                                       |
|-------------------|-------------------------------|------------------------------------------|-----------------------------------------------|
| `collabmd-review` | `mcp/collabmd-review/server.py` | `post_review`, `get_review`          | POST a proposal, GET it back with comments.   |
| `agent-wait`      | `mcp/agent-wait/server.py`      | `wait`, `wait_for`                   | Block/poll without hanging the agent loop.    |

## How they fit together

```text
agent
  ├─ post_review(markdown)  ──►  CollabMD POST /api/review
  │                                → { reviewId, secret, url }
  ├─ hand `url` to the human
  │     human opens browser, comments (line + diagram-element anchors)
  ├─ wait_for(condition="port_open", params={host,port=1317}, timeout_s=60)
  │     (only needed if CollabMD was just started)
  └─ get_review(review_id, secret)  ──►  CollabMD GET /api/review/<id>
                                       → proposal + ## Review Comments appendix
```

## Requirements

- `uv` on PATH (`/opt/homebrew/bin/uv`).
- A running CollabMD instance. The launchd agent
  (`~/Library/LaunchAgents/com.imihai.collabmd.plist`) serves it at
  `http://localhost:1317` on login. Override with `COLLABMD_URL` for the
  review server.

## Files

```
mcp/
├── README.md                     # this file
├── sync.sh                       # sync + re-register helper
├── collabmd-review/
│   ├── server.py                 # post_review, get_review
│   └── README.md
└── agent-wait/
    ├── server.py                 # wait, wait_for
    └── README.md
```
