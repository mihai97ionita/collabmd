#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["mcp[cli]>=1.2,<2", "httpx>=0.27"]
# ///
"""
CollabMD Review MCP server

Four tools for the human-review loop:

1. post_review(markdown, title?) -> { reviewId, secret, url, vaultPath }
   Send a markdown proposal to CollabMD. Returns the absolute browser URL
   the human should open to comment, plus the secret the agent needs to read
   the comments back. Hand the `url` to the human; keep `reviewId` + `secret`
   for the next step.

2. get_review(review_id, secret, include_resolved?) -> markdown string
   Read the proposal back WITH the human's comments woven into a
   `## Review Comments` appendix. Each comment is anchored to a line,
   a text selection, or a Mermaid diagram element (node/edge).
   Pass the secret from post_review. Default excludes resolved threads;
   set include_resolved=true to see the full picture.

3. put_review_md(review_id, secret, markdown) -> { ok, vaultPath, updatedAt }
   Replace the proposal markdown for an existing review. Use this after the
   human has closed the browser tab to apply your revised proposal. Returns
   409 if the browser still has the file open — wait and retry.

4. reply_to_comment(review_id, secret, thread_id, body) -> { ok, messageId }
   Post a reply to an existing comment thread as "Agent". Use this to respond
   to the human's comments without re-posting the whole proposal. The reply
   lands in the comment sidecar and shows up on the next get_review(). Returns
   409 if the browser has the file open — wait and retry.

Requires a running CollabMD instance with the review API enabled
(default http://localhost:1317, override with COLLABMD_URL env).
"""
import json
import os
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP

COLLABMD_URL = os.environ.get("COLLABMD_URL", "http://localhost:1317").rstrip("/")
HTTP_TIMEOUT = 30.0
MCP_HOST = os.environ.get("MCP_HOST", "0.0.0.0")
MCP_PORT = int(os.environ.get("MCP_PORT", "8000"))

mcp = FastMCP("collabmd-review", host=MCP_HOST, port=MCP_PORT)


def _post_review(markdown: str, title: Optional[str]) -> dict:
    payload = {"markdown": markdown}
    if title:
        payload["title"] = title
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.post(f"{COLLABMD_URL}/api/review", json=payload)
        resp.raise_for_status()
        return resp.json()


def _get_review(review_id: str, secret: str, include_resolved: bool) -> str:
    params = {"secret": secret}
    if include_resolved:
        params["resolved"] = "true"
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.get(f"{COLLABMD_URL}/api/review/{review_id}", params=params)
        resp.raise_for_status()
        return resp.text


def _put_review(review_id: str, secret: str, markdown: str) -> dict:
    params = {"secret": secret}
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.put(
            f"{COLLABMD_URL}/api/review/{review_id}",
            params=params,
            json={"markdown": markdown},
        )
        resp.raise_for_status()
        return resp.json()


def _reply_to_comment(review_id: str, secret: str, thread_id: str, body: str) -> dict:
    params = {"secret": secret}
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.post(
            f"{COLLABMD_URL}/api/review/{review_id}/threads/{thread_id}/reply",
            params=params,
            json={"body": body},
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
def post_review(markdown: str, title: str = "") -> str:
    """
    POST a markdown proposal to CollabMD for human review.

    Use this when you want a human to review a proposal, design doc, or any
    markdown content. The human opens the returned `url` in the CollabMD
    browser UI, adds line-anchored or Mermaid-diagram-element-anchored
    comments, then you call get_review() with the returned reviewId + secret
    to read the proposal back with the comments woven in.

    Args:
        markdown: The full markdown content of the proposal. Mermaid ```mermaid
                  fenced blocks render with zoom/pan. Keep it self-contained.
        title:    Optional human-readable title for the review.

    Returns:
        JSON string: { ok, reviewId, secret, vaultPath, url }.
        Hand `url` to the human. Keep `reviewId` and `secret` for get_review().
    """
    if not markdown or not markdown.strip():
        return json.dumps({"error": "markdown must not be empty"})
    try:
        result = _post_review(markdown, title or None)
    except httpx.HTTPStatusError as exc:
        return json.dumps({
            "error": f"CollabMD returned {exc.response.status_code}",
            "body": exc.response.text[:500],
        })
    except httpx.RequestError as exc:
        return json.dumps({"error": f"request failed: {exc}"})
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def get_review(review_id: str, secret: str, include_resolved: bool = False) -> str:
    """
    GET the proposal markdown back WITH the human's comments.

    Returns the original proposal verbatim followed by a
    `## Review Comments` appendix. Each comment block is headed by its anchor:
      - Line-anchored:      `### Line 42 — "quoted excerpt"`
      - Text-anchored:      `### Lines 8-14 — "quoted excerpt"`
      - Diagram-element:    `### Diagram <elementId> — "quoted label"`
    Edited messages carry an `(edited)` marker.

    Args:
        review_id:        The reviewId returned by post_review().
        secret:           The secret returned by post_review().
        include_resolved: If true, include resolved threads marked `(resolved)`.
                          Default false (only open threads).

    Returns:
        The two-part markdown as a string. The proposal is verbatim at the top;
        the `## Review Comments` appendix follows (only if there are comments).
    """
    if not review_id or not secret:
        return "error: review_id and secret are required"
    try:
        return _get_review(review_id, secret, include_resolved)
    except httpx.HTTPStatusError as exc:
        return json.dumps({
            "error": f"CollabMD returned {exc.response.status_code}",
            "body": exc.response.text[:500],
        })
    except httpx.RequestError as exc:
        return json.dumps({"error": f"request failed: {exc}"})


@mcp.tool()
def put_review_md(review_id: str, secret: str, markdown: str) -> str:
    """
    PUT (replace) the proposal markdown for an existing review.

    Use this after the human has reviewed your proposal and closed the
    browser tab — you apply your revised markdown, then re-POST or let the
    human re-open the same URL to review the next iteration.

    The write only touches the proposal file (tmp/review/<id>.md). It does
    NOT affect comment threads — those live in a separate sidecar and are
    readable via get_review().

    If the browser still has the file open in a collaboration session, the
    server returns 409 — wait for the human to close it (or call
    wait_for("http_healthy", ...) / retry) and try again.

    Args:
        review_id: The reviewId returned by post_review().
        secret:    The secret returned by post_review().
        markdown:  The full new markdown content of the proposal.

    Returns:
        JSON string: { ok, vaultPath, updatedAt } on success.
        On 409: { "error": "...", "body": "...", "status": 409 } — retry.
    """
    if not review_id or not secret:
        return json.dumps({"error": "review_id and secret are required"})
    if not markdown or not markdown.strip():
        return json.dumps({"error": "markdown must not be empty"})
    try:
        result = _put_review(review_id, secret, markdown)
    except httpx.HTTPStatusError as exc:
        return json.dumps({
            "error": f"CollabMD returned {exc.response.status_code}",
            "body": exc.response.text[:500],
            "status": exc.response.status_code,
        })
    except httpx.RequestError as exc:
        return json.dumps({"error": f"request failed: {exc}"})
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def reply_to_comment(review_id: str, secret: str, thread_id: str, body: str) -> str:
    """
    Reply to an existing comment thread as "Agent".

    Use this to respond to the human's comments without re-posting the whole
    proposal. The reply is appended to the thread's messages and persists in
    the comment sidecar; it shows up on the next get_review() call.

    Find thread_id values by calling get_review() with include_resolved=true
    and inspecting the ## Review Comments appendix — each thread block starts
    with `### Line N` or `### Diagram <elementId>`. The thread_id is the
    `id` field of the thread (not currently rendered in the markdown; you can
    also read it from the sidecar JSON directly if needed).

    If the browser still has the file open in a collaboration session, the
    server returns 409 — wait for the human to close it and retry.

    Args:
        review_id: The reviewId returned by post_review().
        secret:    The secret returned by post_review().
        thread_id: The id of the thread to reply to.
        body:      The reply text (markdown). Must not be empty.

    Returns:
        JSON string: { ok, messageId, threadId } on success.
        On 409: { "error": "...", "body": "...", "status": 409 } — retry.
    """
    if not review_id or not secret or not thread_id:
        return json.dumps({"error": "review_id, secret, and thread_id are required"})
    if not body or not body.strip():
        return json.dumps({"error": "body must not be empty"})
    try:
        result = _reply_to_comment(review_id, secret, thread_id, body)
    except httpx.HTTPStatusError as exc:
        return json.dumps({
            "error": f"CollabMD returned {exc.response.status_code}",
            "body": exc.response.text[:500],
            "status": exc.response.status_code,
        })
    except httpx.RequestError as exc:
        return json.dumps({"error": f"request failed: {exc}"})
    return json.dumps(result, ensure_ascii=False)


if __name__ == "__main__":
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    mcp.run(transport=transport)

