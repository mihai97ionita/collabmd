#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["mcp[cli]>=1.2,<2", "httpx>=0.27"]
# ///
"""
CollabMD Review MCP server

Six tools for the human-review loop:

1. post_review(markdown, title?) -> { reviewId, url, vaultPath }
   Send a markdown proposal to CollabMD. Returns the absolute browser URL
   the human should open to comment, plus the reviewId the agent needs to
   read the comments back. Hand the `url` to the human; keep `reviewId`
   for the next step. The reviewId is the single capability token —
   knowing it grants access to the review.

2. get_review(review_id, include_resolved?) -> markdown string
   Read the proposal back WITH the human's comments woven into a
   `## Review Comments` appendix. Each comment is anchored to a line,
   a text selection, or a Mermaid diagram element (node/edge).
   Default excludes resolved threads; set include_resolved=true to see
   the full picture.

3. put_review_md(review_id, markdown) -> { ok, vaultPath, updatedAt }
   Replace the proposal markdown for an existing review. Use this after the
   human has closed the browser tab to apply your revised proposal. Returns
   409 if the browser still has the file open — wait and retry.

4. reply_to_comment(review_id, thread_id, body) -> { ok, messageId }
   Post a reply to an existing comment thread as "Agent". Use this to respond
   to the human's comments without re-posting the whole proposal. The reply
   lands in the comment sidecar and shows up on the next get_review(). Returns
   409 if the browser has the file open — wait and retry.

5. reanchor_review_threads(review_id, moves) -> { ok, moved }
   Move line/text review threads to explicit 1-based line ranges in the current
   proposal. The whole batch is validated before the comment sidecar is updated.

6. wait_for_review(review_id, timeout?, since?, review_url?) -> { ok, mode, canReply, canEdit, reason, since, timedOut, reviewConcluded, canProceed }
   Long-poll until the human signals via the browser UI. Four modes:
   - "peek"     — human is looking; agent stays review-only.
   - "handoff"  — human is done; agent may edit the proposal (PUT).
   - "approve"  — human approved the proposal; terminal.
   - "deny"     — human denied the proposal; terminal.
   Blocks up to `timeout` (default "20m"). On notify, returns mode/canEdit/
   reason/since with timedOut=false. On timeout, returns timedOut=true.
   On reviewConcluded=true, stop re-waiting. If canProceed=true, the human
   approved the proposal as a plan — go execute what was agreed. If
   canProceed=false, the review is over (approved-plain or denied) — conclude.
   Re-call to wait again; pass the returned `since` to avoid missing notifies
   that fired between calls. Pass `review_url` (from post_review) so the
   macOS notification fired at wait-start opens the review on click.

Requires a running CollabMD instance with the review API enabled
(default http://localhost:1317, override with COLLABMD_URL env).
"""
import json
import os
import subprocess
import threading
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


def _get_review(review_id: str, include_resolved: bool) -> str:
    params = {}
    if include_resolved:
        params["resolved"] = "true"
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.get(f"{COLLABMD_URL}/api/review/{review_id}", params=params)
        resp.raise_for_status()
        return resp.text


def _put_review(review_id: str, markdown: str) -> dict:
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.put(
            f"{COLLABMD_URL}/api/review/{review_id}",
            json={"markdown": markdown},
        )
        resp.raise_for_status()
        return resp.json()


def _reply_to_comment(review_id: str, thread_id: str, body: str) -> dict:
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.post(
            f"{COLLABMD_URL}/api/review/{review_id}/threads/{thread_id}/reply",
            json={"body": body},
        )
        resp.raise_for_status()
        return resp.json()


def _reanchor_review_threads(review_id: str, moves: list[dict]) -> dict:
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.patch(
            f"{COLLABMD_URL}/api/review/{review_id}/anchors",
            json={"moves": moves},
        )
        resp.raise_for_status()
        return resp.json()


def _parse_timeout_to_seconds(timeout: str) -> float:
    """Parse a timeout string like "20m", "5m", "60s", or a bare number of seconds."""
    if timeout is None:
        return 1200.0  # 20 minutes default
    value = str(timeout).strip().lower()
    if not value:
        return 1200.0
    if value.endswith("s"):
        return float(value[:-1])
    if value.endswith("m"):
        return float(value[:-1]) * 60
    if value.endswith("h"):
        return float(value[:-1]) * 3600
    return float(value)


def _fire_wait_notification(review_url: Optional[str]) -> None:
    """Fire a macOS notification so the user knows the agent is waiting.

    Uses terminal-notifier (brew install) with -open URL so clicking the
    notification opens the review in the browser. Best-effort: any failure
    (terminal-notifier missing, not on macOS, permission denied) is swallowed
    so the wait itself never fails. Fired in a daemon thread so it does not
    block or delay the long-poll.
    """
    if not review_url:
        return
    try:
        subprocess.Popen(
            [
                "terminal-notifier",
                "-title", "CollabMD",
                "-message", "Agent waiting — click to open the review.",
                "-sound", "default",
                "-open", review_url,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        # Notification is best-effort; never fail the wait.
        pass


async def _wait_for_review(review_id: str, timeout: str, since: str, review_url: Optional[str]) -> dict:
    seconds = _parse_timeout_to_seconds(timeout)
    # Add a small buffer over the server cap so httpx doesn't time out before
    # the server's 202 arrives.
    http_timeout = seconds + 5
    params = {}
    if since:
        params["since"] = since
    # Fire a macOS notification at wait-start so the user is pulled back to
    # action even if they switched away from the terminal.
    threading.Thread(target=_fire_wait_notification, args=(review_url,), daemon=True).start()
    # async + AsyncClient so the MCP server's event loop stays responsive to
    # liveness pings while this long-poll is in flight. A blocking httpx.Client
    # call starves the loop and the MCP client declares the server unresponsive.
    async with httpx.AsyncClient(timeout=http_timeout) as client:
        resp = await client.get(
            f"{COLLABMD_URL}/api/review/{review_id}/wait",
            params=params,
        )
        if resp.status_code == 202:
            return {"ok": True, "timedOut": True}
        resp.raise_for_status()
        result = resp.json()
        result.setdefault("ok", True)
        result["timedOut"] = False
        return result


@mcp.tool()
def post_review(markdown: str, title: str) -> str:
    """
    POST a markdown proposal to CollabMD for human review.

    Use this when you want a human to review a proposal, design doc, or any
    markdown content. The human opens the returned `url` in the CollabMD
    browser UI, adds line-anchored or Mermaid-diagram-element-anchored
    comments, then you call get_review() with the returned reviewId to read
    the proposal back with the comments woven in.

    Args:
        markdown: The full markdown content of the proposal. Mermaid ```mermaid
                  fenced blocks render with zoom/pan. Keep it self-contained.
        title:    Human-readable title for the review (required). The vault
                  file is named after this title (e.g. "my-proposal-<id>.md"),
                  so pick something descriptive the human will recognise.

    Returns:
        JSON string: { ok, reviewId, vaultPath, url }.
        Hand `url` to the human. Keep `reviewId` for get_review(). The
        reviewId is the single capability token — knowing it grants access.
    """
    if not markdown or not markdown.strip():
        return json.dumps({"error": "markdown must not be empty"})
    if not title or not title.strip():
        return json.dumps({"error": "title is required"})
    try:
        result = _post_review(markdown, title.strip())
    except httpx.HTTPStatusError as exc:
        return json.dumps({
            "error": f"CollabMD returned {exc.response.status_code}",
            "body": exc.response.text[:500],
        })
    except httpx.RequestError as exc:
        return json.dumps({"error": f"request failed: {exc}"})
    return json.dumps(result, ensure_ascii=False)


@mcp.tool()
def get_review(review_id: str, include_resolved: bool = False) -> str:
    """
    GET the proposal markdown back WITH the human's comments.

    Returns the original proposal verbatim followed by a
    `## Review Comments` appendix. Each comment block is headed by its anchor:
      - Line-anchored:      `### Line 42 — "quoted excerpt"`
      - Text-anchored:      `### Lines 8-14 — "quoted excerpt"`
      - Diagram-element:    `### Diagram <elementId> — "quoted label"`
    Each thread also carries an HTML comment with its id:
      `<!-- thread-id: <id> -->`
    Use that id as the `thread_id` argument to reply_to_comment().
    Edited messages carry an `(edited)` marker.

    Args:
        review_id:        The reviewId returned by post_review(). The reviewId
                          is the single capability token — knowing it grants
                          access to the review.
        include_resolved: If true, include resolved threads marked `(resolved)`.
                          Default false (only open threads).

    Returns:
        The two-part markdown as a string. The proposal is verbatim at the top;
        the `## Review Comments` appendix follows (only if there are comments).
    """
    if not review_id:
        return "error: review_id is required"
    try:
        return _get_review(review_id, include_resolved)
    except httpx.HTTPStatusError as exc:
        return json.dumps({
            "error": f"CollabMD returned {exc.response.status_code}",
            "body": exc.response.text[:500],
        })
    except httpx.RequestError as exc:
        return json.dumps({"error": f"request failed: {exc}"})


@mcp.tool()
def put_review_md(review_id: str, markdown: str) -> str:
    """
    PUT (replace) the proposal markdown for an existing review.

    Use this after the human has reviewed your proposal and closed the
    browser tab — you apply your revised markdown, then re-POST or let the
    human re-open the same URL to review the next iteration.

    The write only touches the proposal file (tmp/review/<id>.md). It does
    NOT affect comment threads — those live in a separate sidecar and are
    readable via get_review().

    Size limit: the proposal markdown is capped by the server's HTTP body
    limit (8 MiB). Oversized PUTs fail with 413 Request body too large.

    If the browser still has the file open in a collaboration session, the
    server returns 409 — wait for the human to close it (or call
    wait_for("http_healthy", ...) / retry) and try again.

    Args:
        review_id: The reviewId returned by post_review(). The reviewId is
                   the single capability token — knowing it grants access.
        markdown:  The full new markdown content of the proposal.

    Returns:
        JSON string: { ok, vaultPath, updatedAt } on success.
        On 409: { "error": "...", "body": "...", "status": 409 } — retry.
    """
    if not review_id:
        return json.dumps({"error": "review_id is required"})
    if not markdown or not markdown.strip():
        return json.dumps({"error": "markdown must not be empty"})
    try:
        result = _put_review(review_id, markdown)
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
def reply_to_comment(review_id: str, thread_id: str, body: str) -> str:
    """
    Reply to an existing comment thread as "Agent".

    Use this to respond to the human's comments without re-posting the whole
    proposal. The reply is appended to the thread's messages and persists in
    the comment sidecar; it shows up on the next get_review() call.

    When the human has the review open in the browser, the reply is routed
    through the live collaboration room and appears in real time — no need to
    wait for the human to close the tab. When no browser session is active,
    the reply is written directly to the sidecar.

    Find thread_id values by calling get_review() with include_resolved=true
    and looking for the `<!-- thread-id: <id> -->` HTML comment under each
    thread heading in the ## Review Comments appendix.

    Body length limit: the reply body is capped at 2000 characters (after
    \\r\\n normalisation and trim). Bodies longer than that are silently
    truncated. The 200 response reports whether truncation happened via
    `truncated: true`, plus `bodyLength` (the persisted length) and
    `maxLength` (2000). If `truncated` is true, split the reply into multiple
    reply_to_comment() calls or shorten the text before re-sending.

    Args:
        review_id: The reviewId returned by post_review(). The reviewId is
                   the single capability token — knowing it grants access.
        thread_id: The id of the thread to reply to.
        body:      The reply text (markdown). Must not be empty. Cap: 2000 chars.

    Returns:
        JSON string: { ok, messageId, threadId, truncated, bodyLength, maxLength }
        on success. `truncated` is true when the input exceeded maxLength and was
        sliced. On error: { error, status? } — 404 unknown review/thread,
        422 empty body, 409 live-session conflict.
    """
    if not review_id or not thread_id:
        return json.dumps({"error": "review_id and thread_id are required"})
    if not body or not body.strip():
        return json.dumps({"error": "body must not be empty"})
    try:
        result = _reply_to_comment(review_id, thread_id, body)
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
def reanchor_review_threads(review_id: str, moves: list[dict]) -> str:
    """Move line/text review threads to explicit ranges in the current proposal.

    Each move contains ``threadId``, 1-based ``startLine`` and ``endLine``, and
    a non-empty ``quote`` contained within those selected proposal lines. The
    server validates the complete batch before writing any anchor changes.
    """
    if not review_id:
        return json.dumps({"error": "review_id is required"})
    if not isinstance(moves, list) or not moves:
        return json.dumps({"error": "moves must be a non-empty list"})
    try:
        result = _reanchor_review_threads(review_id, moves)
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
async def wait_for_review(review_id: str, timeout: str = "20m", since: str = "", review_url: str = "") -> str:
    """
    Long-poll until the human signals via the CollabMD browser UI.

    Blocks until the human triggers a notify from the browser, or until the
    timeout elapses. The CollabMD server holds the HTTP connection open for up
    to 20 minutes; this tool sets an httpx timeout slightly above that so it
    doesn't disconnect prematurely.

    Four notify modes:
      - "peek"    — human is looking; agent stays review-only.
      - "handoff" — human is done; agent may edit the proposal (PUT). canEdit
        is true only for handoff with no live browser session.
      - "approve" — human approved the proposal; terminal.
      - "deny"    — human denied the proposal; terminal.

    On a notify, returns:
      { ok, mode, canReply, canEdit, reason, since, timedOut,
        reviewConcluded, canProceed }
    - mode: one of "peek", "handoff", "approve", "deny".
    - canEdit: true only for handoff with no live browser session.
    - reason: null when canEdit is true, or a string explaining why the edit
      would fail (e.g. "human still owns the live session; PUT will 409") when
      canEdit is false. For approve/deny: "approved" / "denied".
    - reviewConcluded: true when mode is "approve" or "deny" (terminal). On
      reviewConcluded=true, stop re-waiting. If canProceed=true, the human
      approved the proposal as a plan — go execute what was agreed. If
      canProceed=false, the review is over (approved-plain or denied) —
      conclude.
    - canProceed: true only when mode is "approve" and the human clicked
      "Approve & Proceed" in the browser.

    On timeout (no notify within the window), returns:
      { ok: true, timedOut: true }

    Re-call to wait again. Pass the returned `since` token on the next call
    to avoid missing notifies that fired between calls (sticky delivery).

    A native macOS notification is fired at wait-start (via terminal-notifier)
    so the user is pulled back to the terminal even if they switched away.
    Pass `review_url` (from post_review's return) so clicking the
    notification opens the review directly in the browser.

    Args:
        review_id:   The reviewId returned by post_review().
        timeout:     How long to wait. String like "20m" (default), "5m",
                     "60s", or a bare number of seconds. Capped at 20m by
                     the server.
        since:       Opaque token from a previous wait_for_review() response.
                     Pass "" on the first call; pass the returned `since` on
                     re-calls to skip already-consumed notifies.
        review_url:  The `url` returned by post_review(). Used for the
                     click-to-open action on the macOS notification. Pass ""
                     if unavailable; the notification still fires but
                     clicking it won't open the review.
    """
    if not review_id:
        return json.dumps({"error": "review_id is required"})
    try:
        result = await _wait_for_review(review_id, timeout, since, review_url or None)
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

