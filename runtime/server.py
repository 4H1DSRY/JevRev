"""Standard-library HTTP service for the local Qwen3 reranker."""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Sequence

try:
    from .scorer import DEFAULT_INSTRUCTION, Qwen3Reranker, ScoreItem, ScoreResult
except ImportError:  # Support `python runtime/server.py` as well as `python -m`.
    from scorer import DEFAULT_INSTRUCTION, Qwen3Reranker, ScoreItem, ScoreResult


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4877
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_ITEMS = 256
MAX_BATCH_SIZE = 64


@dataclass(frozen=True, slots=True)
class ParsedScoreRequest:
    items: list[ScoreItem]
    batch_size: int | None


class RequestError(ValueError):
    def __init__(self, status: HTTPStatus, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _required_string(value: Any, field: str, index: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            "invalid_request",
            f"items[{index}].{field} must be a non-empty string",
        )
    return value


def parse_score_request(payload: Any) -> ParsedScoreRequest:
    if not isinstance(payload, dict):
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            "invalid_request",
            "request body must be a JSON object",
        )
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            "invalid_request",
            "items must be a non-empty array",
        )
    if len(raw_items) > MAX_ITEMS:
        raise RequestError(
            HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            "too_many_items",
            f"a request may contain at most {MAX_ITEMS} items",
        )

    items: list[ScoreItem] = []
    seen_ids: set[str] = set()
    for index, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, dict):
            raise RequestError(
                HTTPStatus.BAD_REQUEST,
                "invalid_request",
                f"items[{index}] must be an object",
            )
        item_id = _required_string(raw_item.get("id"), "id", index)
        if item_id in seen_ids:
            raise RequestError(
                HTTPStatus.BAD_REQUEST,
                "duplicate_id",
                f"duplicate item id: {item_id}",
            )
        seen_ids.add(item_id)
        instruction = raw_item.get("instruction", DEFAULT_INSTRUCTION)
        items.append(
            ScoreItem(
                item_id=item_id,
                query=_required_string(raw_item.get("query"), "query", index),
                document=_required_string(
                    raw_item.get("document"), "document", index
                ),
                instruction=_required_string(instruction, "instruction", index),
            )
        )

    batch_size = payload.get("batch_size")
    if batch_size is not None:
        if (
            not isinstance(batch_size, int)
            or isinstance(batch_size, bool)
            or not 1 <= batch_size <= MAX_BATCH_SIZE
        ):
            raise RequestError(
                HTTPStatus.BAD_REQUEST,
                "invalid_request",
                f"batch_size must be an integer from 1 to {MAX_BATCH_SIZE}",
            )
    return ParsedScoreRequest(items=items, batch_size=batch_size)


def _handler_for(scorer: Qwen3Reranker) -> type[BaseHTTPRequestHandler]:
    class RerankerHandler(BaseHTTPRequestHandler):
        server_version = "JevRevRuntime/0.1"

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            if self.path != "/health":
                self._send_error(HTTPStatus.NOT_FOUND, "not_found", "not found")
                return
            self._send_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "loaded": True,
                    "model": scorer.model_name,
                    "device": scorer.device,
                    "max_length": scorer.max_length,
                },
            )

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
            if self.path != "/v1/score":
                self._send_error(HTTPStatus.NOT_FOUND, "not_found", "not found")
                return
            try:
                payload = self._read_json_body()
                request = parse_score_request(payload)
                started = time.perf_counter()
                result = scorer.score(request.items, batch_size=request.batch_size)
                duration_ms = round((time.perf_counter() - started) * 1000, 3)
                scores = [
                    {"id": item.item_id, "score": score}
                    for item, score in zip(request.items, result.scores, strict=True)
                ]
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "model": scorer.model_name,
                        "device": scorer.device,
                        "count": len(scores),
                        "scores": scores,
                        "input_tokens": result.input_tokens,
                        "duration_ms": duration_ms,
                    },
                )
            except RequestError as exc:
                self._send_error(exc.status, exc.code, str(exc))
            except Exception as exc:  # Keep the process alive after model failures.
                self.log_error("inference failed: %s", exc)
                self._send_error(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "inference_error",
                    str(exc),
                )

        def _read_json_body(self) -> Any:
            raw_length = self.headers.get("Content-Length")
            if raw_length is None:
                raise RequestError(
                    HTTPStatus.LENGTH_REQUIRED,
                    "length_required",
                    "Content-Length is required",
                )
            try:
                length = int(raw_length)
            except ValueError as exc:
                raise RequestError(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_request",
                    "Content-Length must be an integer",
                ) from exc
            if length < 1:
                raise RequestError(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_json",
                    "request body is empty",
                )
            if length > MAX_REQUEST_BYTES:
                raise RequestError(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    "request_too_large",
                    f"request body may not exceed {MAX_REQUEST_BYTES} bytes",
                )
            try:
                return json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise RequestError(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_json",
                    "request body must be valid UTF-8 JSON",
                ) from exc

        def _send_error(self, status: HTTPStatus, code: str, message: str) -> None:
            self._send_json(status, {"error": {"code": code, "message": message}})

        def _send_json(self, status: HTTPStatus, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode(
                "utf-8"
            )
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            super().log_message(format, *args)

    return RerankerHandler


def make_server(
    host: str,
    port: int,
    scorer: Qwen3Reranker,
) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), _handler_for(scorer))
    server.daemon_threads = True
    return server


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        default=os.environ.get("SPECJEV_MODEL_PATH"),
        help="local model directory or locally cached model ID (SPECJEV_MODEL_PATH)",
    )
    parser.add_argument(
        "--host", default=os.environ.get("SPECJEV_HOST", DEFAULT_HOST)
    )
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("SPECJEV_PORT", DEFAULT_PORT))
    )
    parser.add_argument(
        "--device", default=os.environ.get("SPECJEV_DEVICE", "auto")
    )
    parser.add_argument(
        "--max-length",
        type=int,
        default=int(os.environ.get("SPECJEV_MAX_LENGTH", "8192")),
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=int(os.environ.get("SPECJEV_BATCH_SIZE", "8")),
    )
    parser.add_argument(
        "--allow-download",
        action="store_true",
        help="allow Transformers to download a missing model instead of staying local-only",
    )
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="allow model repository Python code (disabled by default)",
    )
    parser.add_argument(
        "--skip-warmup",
        action="store_true",
        help="do not run a one-item inference before accepting requests",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.model:
        raise SystemExit("--model or SPECJEV_MODEL_PATH is required")
    scorer = Qwen3Reranker(
        args.model,
        device=args.device,
        max_length=args.max_length,
        default_batch_size=args.batch_size,
        local_files_only=not args.allow_download,
        trust_remote_code=args.trust_remote_code,
    )
    if not args.skip_warmup:
        scorer.score(
            [
                ScoreItem(
                    item_id="warmup",
                    query="The candidate must satisfy the requirement.",
                    document="The candidate satisfies the requirement.",
                )
            ],
            batch_size=1,
        )
    server = make_server(args.host, args.port, scorer)
    print(
        f"JevRev runtime listening on http://{args.host}:{args.port} "
        f"({scorer.model_name} on {scorer.device})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
