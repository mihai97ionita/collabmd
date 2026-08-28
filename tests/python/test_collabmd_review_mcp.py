import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx


SERVER_PATH = Path(__file__).parents[2] / "mcp" / "collabmd-review" / "server.py"
SPEC = importlib.util.spec_from_file_location("collabmd_review_server", SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class ReanchorReviewThreadsTest(unittest.TestCase):
    def setUp(self):
        self.client_patcher = patch.object(SERVER.httpx, "Client")
        self.client_factory = self.client_patcher.start()
        self._client = self.client_factory.return_value.__enter__.return_value
        self.response = self._client.patch.return_value

    def tearDown(self):
        self.client_patcher.stop()

    def test_sends_secret_in_header_and_returns_success_result(self):
        moves = [{
            "threadId": "thread-1",
            "startLine": 2,
            "endLine": 3,
            "quote": "Selected text",
        }]
        self.response.json.return_value = {"ok": True, "moved": ["thread-1"]}

        result = json.loads(SERVER.reanchor_review_threads(
            "review-1", "test-secret", moves,
        ))

        self._client.patch.assert_called_once_with(
            f"{SERVER.COLLABMD_URL}/api/review/review-1/anchors",
            headers={"X-Review-Secret": "test-secret"},
            json={"moves": moves},
        )
        self.response.raise_for_status.assert_called_once_with()
        self.assertEqual(result, {"ok": True, "moved": ["thread-1"]})

    def test_returns_http_error_envelope(self):
        request = httpx.Request(
            "PATCH", f"{SERVER.COLLABMD_URL}/api/review/review-1/anchors",
        )
        error_response = httpx.Response(409, request=request, text="browser open")
        self.response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "conflict", request=request, response=error_response,
        )

        result = json.loads(SERVER.reanchor_review_threads(
            "review-1",
            "test-secret",
            [{"threadId": "thread-1", "startLine": 2, "endLine": 2, "quote": "Text"}],
        ))

        self.assertEqual(result, {
            "error": "CollabMD returned 409",
            "body": "browser open",
            "status": 409,
        })


if __name__ == "__main__":
    unittest.main()