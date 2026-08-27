# collabmd-review MCP

A local stdio MCP server that exposes the CollabMD review API to any Augment
session. Two tools for the human-review loop.

## Tools

### `post_review(markdown, title="")`

POST a markdown proposal to CollabMD. Returns JSON:

```json
{
  "ok": true,
  "reviewId": "<uuid>",
  "secret": "<uuid>",
  "vaultPath": "tmp/review/<uuid>.md",
  "url": "http://localhost:1317/#file=tmp%2Freview%2F<uuid>.md"
}
```

Hand `url` to the human (they open it in the browser to comment). Keep
`reviewId` and `secret` for `get_review`.

### `get_review(review_id, secret, include_resolved=false)`

GET the proposal back WITH the human's comments. Returns the two-part
markdown:

- The original proposal verbatim (Mermaid fences render in the browser).
- A `## Review Comments` appendix with one block per comment thread:

```markdown
### Line 42 — "quoted excerpt"
- **@reviewer** (2026-08-26 14:03): This will OOM. Add LRU eviction.

### Diagram <elementId> — "node label"
- **@reviewer** (2026-08-26 14:10): Missing the auth service here.
```

Edited messages carry `(edited)`. Resolved threads are excluded by default;
pass `include_resolved=true` to see them marked `(resolved)`.

## Requirements

- A running CollabMD instance with the review API (`POST /api/review` and
  `GET /api/review/:id`) enabled. Default `http://localhost:1317`; override
  with the `COLLABMD_URL` env var.
- `uv` on PATH. The server is an inline uv script — no venv needed; uv
  resolves `mcp[cli]` + `httpx` on first run.

## Registration

This repo copy is the **single source of truth** — Augment launches the
script directly from here, so you only edit in one place. Register with
Augment (auggie CLI), replacing `<repo>` with your local checkout path:

```bash
auggie mcp add-json collabmd-review '{
  "command": "<uv-path>",
  "args": ["run", "--script", "<repo>/mcp/collabmd-review/server.py"],
  "env": { "COLLABMD_URL": "http://localhost:1317" }
}'

auggie mcp list        # verify
```

Or run `./mcp/register.sh` from the repo root, which resolves the paths
automatically.

If you previously registered the `~/.augment/tools/collabmd-review/server.py`
copy, remove it first so Augment doesn't hold two entries:

```bash
auggie mcp remove collabmd-review      # drop the old tools/ registration
auggie mcp add-json collabmd-review '{ … }'   # re-add with the repo path
```

No `cp` step — the script runs in place from `mcp/collabmd-review/server.py`.

## Agent usage pattern

```
1. post_review(markdown=<proposal>, title="…")
   → you get { reviewId, secret, url }
2. tell the human: "open <url> and add comments"
3. (wait for the human to finish)
4. get_review(review_id=<reviewId>, secret=<secret>)
   → you read the proposal + ## Review Comments appendix
5. act on the comments; iterate (go to 1 with an updated proposal)
```

## Files

- `server.py` — the MCP server (uv inline script, deps: `mcp[cli]>=1.2,<2`, `httpx>=0.27`).
- `README.md` — this file.
