from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request

from runtime.scorer import ScoreResult
from runtime.server import make_server, parse_score_request


class FakeScorer:
    model_name = "test-model"
    device = "cpu"
    max_length = 1024

    def score(self, items, *, batch_size=None):
        del batch_size
        return ScoreResult(
            scores=[0.75 + index * 0.01 for index, _ in enumerate(items)],
            input_tokens=17 * len(items),
        )


class RequestParsingTest(unittest.TestCase):
    def test_parses_batch_and_uses_default_instruction(self) -> None:
        request = parse_score_request(
            {
                "items": [
                    {"id": "a", "query": "question", "document": "answer"},
                    {
                        "id": "b",
                        "query": "question",
                        "document": "other answer",
                        "instruction": "Judge coverage.",
                    },
                ],
                "batch_size": 2,
            }
        )

        self.assertEqual([item.item_id for item in request.items], ["a", "b"])
        self.assertTrue(request.items[0].instruction)
        self.assertEqual(request.batch_size, 2)

    def test_rejects_duplicate_ids(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate item id"):
            parse_score_request(
                {
                    "items": [
                        {"id": "a", "query": "q", "document": "d"},
                        {"id": "a", "query": "q", "document": "d"},
                    ]
                }
            )


class HttpServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = make_server("127.0.0.1", 0, FakeScorer())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def get_json(self, path: str):
        with urllib.request.urlopen(self.base_url + path, timeout=2) as response:
            return response.status, json.load(response)

    def post_json(self, path: str, body) -> tuple[int, dict]:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            return response.status, json.load(response)

    def test_health(self) -> None:
        status, body = self.get_json("/health")

        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["model"], "test-model")
        self.assertEqual(body["device"], "cpu")

    def test_scores_batch_with_usage_and_duration(self) -> None:
        status, body = self.post_json(
            "/v1/score",
            {
                "items": [
                    {"id": "a", "query": "q", "document": "d"},
                    {"id": "b", "query": "q", "document": "d2"},
                ]
            },
        )

        self.assertEqual(status, 200)
        self.assertEqual(
            body["scores"],
            [{"id": "a", "score": 0.75}, {"id": "b", "score": 0.76}],
        )
        self.assertEqual(body["input_tokens"], 34)
        self.assertIsInstance(body["duration_ms"], float)

    def test_returns_structured_validation_error(self) -> None:
        request = urllib.request.Request(
            self.base_url + "/v1/score",
            data=json.dumps({"items": []}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request, timeout=2)
        error = raised.exception
        body = json.load(error)
        self.assertEqual(error.code, 400)
        self.assertEqual(body["error"]["code"], "invalid_request")
        error.close()


if __name__ == "__main__":
    unittest.main()
