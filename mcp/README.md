# MCP tools

Local stdio MCP servers used by the CollabMD agent loop. Each server is a
self-contained `uv` inline script (no venv, no install — `uv run --script`
resolves deps on first launch).

This directory is the **single source of truth**. Augment launches the
scripts directly from here — no copy is synced into `~/.augment/tools/`, so
you only ever edit `mcp/<name>/server.py`. Register once (see each server's
README or run `./mcp/register.sh`), and from then on Augment runs the script
in place.

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

- `uv` on PATH.
- A running CollabMD instance serving the review API at `http://localhost:1317`
  (override with `COLLABMD_URL` for the review server). The repo includes a
  launchd agent setup for macOS that auto-starts CollabMD on login; see
  `AGENTS.md` for the plist path and management commands.

## Files

```
mcp/
├── README.md                     # this file
├── register.sh                   # register both servers with auggie (run from repo path)
├── collabmd-review/
│   ├── server.py                 # post_review, get_review
│   └── README.md
└── agent-wait/
    ├── server.py                 # wait, wait_for
    └── README.md
```
