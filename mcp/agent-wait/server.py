#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["mcp[cli]>=1.2,<2", "httpx>=0.27"]
# ///
"""
agent-wait MCP server

Tools:

  wait(seconds, label="")
    Block for N seconds, then return. Keeps the agentic loop alive without
    polling. Use before checking a terminal signal (pipeline status, health
    endpoint, pod count, etc.).

  wait_for(condition, params, timeout_s, interval_s=2)
    Poll until a condition is met, then return. Conditions:
      - http_healthy : params = {"url": "..."} — GET until 2xx
      - port_open    : params = {"host": "...", "port": 1234} — TCP connect
      - file_exists  : params = {"path": "/abs/path"} — os.path.exists
    Returns {"ok": bool, "elapsed_ms": int, "timed_out": bool}.
    Caps total wait at timeout_s so it never hangs a session indefinitely.
"""
import asyncio
import os
import socket
import time

import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("agent-wait")


@mcp.tool()
async def wait(seconds: int, label: str = "") -> str:
    """
    Block for `seconds` seconds, then return. Keeps the agentic loop alive
    without polling. Use before checking a terminal signal (pipeline status,
    health endpoint, pod count, etc.).

    Args:
        seconds: How long to wait (in seconds).
        label:   Optional human-readable reason, e.g. "Jenkins — initial window".
    """
    if seconds <= 0:
        return "⚠️  seconds must be > 0, skipped."
    await asyncio.sleep(seconds)
    suffix = f" — {label}" if label else ""
    return f"⏳ waited {seconds}s{suffix}"


async def _check_http_healthy(url: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
        return 200 <= resp.status_code < 300
    except Exception:
        return False


async def _check_port_open(host: str, port: int) -> bool:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _tcp_connect, host, port)


def _tcp_connect(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=2.0):
            return True
    except Exception:
        return False


async def _check_file_exists(path: str) -> bool:
    return bool(path) and os.path.exists(path)


CONDITION_CHECKERS = {
    "http_healthy": lambda params: _check_http_healthy(params.get("url", "")),
    "port_open": lambda params: _check_port_open(
        params.get("host", "127.0.0.1"), int(params.get("port", 0)),
    ),
    "file_exists": lambda params: _check_file_exists(params.get("path", "")),
}


@mcp.tool()
async def wait_for(
    condition: str,
    params: dict,
    timeout_s: int,
    interval_s: int = 2,
) -> str:
    """
    Poll until `condition` is met, then return. Use instead of a blind wait
    when you have a concrete signal to check (server back, build artifact
    written, etc.).

    Args:
        condition: One of "http_healthy", "port_open", "file_exists".
        params:    Condition-specific params:
                   - http_healthy: {"url": "http://localhost:1317/api/health"}
                   - port_open:    {"host": "127.0.0.1", "port": 1317}
                   - file_exists:  {"path": "/abs/path/to/file"}
        timeout_s: Max seconds to wait before giving up. Caps total wait so
                   the session never hangs indefinitely.
        interval_s: Seconds between checks (default 2).

    Returns:
        JSON: {"ok": bool, "elapsed_ms": int, "timed_out": bool}.
    """
    checker = CONDITION_CHECKERS.get(condition)
    if checker is None:
        return f'{{"ok": false, "error": "unknown condition: {condition}"}}'
    if timeout_s <= 0:
        return '{"ok": false, "error": "timeout_s must be > 0"}'
    interval = max(0.5, float(interval_s))

    started = time.monotonic()
    deadline = started + timeout_s
    while True:
        if await checker(params):
            elapsed = int((time.monotonic() - started) * 1000)
            return f'{{"ok": true, "elapsed_ms": {elapsed}}}'
        if time.monotonic() >= deadline:
            elapsed = int((time.monotonic() - started) * 1000)
            return f'{{"ok": false, "timed_out": true, "elapsed_ms": {elapsed}}}'
        await asyncio.sleep(min(interval, max(0.1, deadline - time.monotonic())))


if __name__ == "__main__":
    mcp.run()
