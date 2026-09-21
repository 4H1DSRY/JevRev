"""Run semantic smoke checks against a deployed local scorer."""

from __future__ import annotations

import argparse
import json
import urllib.request


def build_items() -> list[dict[str, str]]:
    requirement_instruction = (
        "Judge whether the Document satisfies the Query requirement. "
        "Answer yes only if it does."
    )
    duplicate_instruction = (
        "Judge whether the two candidates use materially the same mechanism. "
        "Answer yes only if they are duplicative."
    )
    return [
        {
            "id": "requirement_yes",
            "instruction": requirement_instruction,
            "query": "The implementation must remain pure JavaScript.",
            "document": "The solution remains pure JavaScript and adds no native dependency.",
        },
        {
            "id": "requirement_no",
            "instruction": requirement_instruction,
            "query": "The implementation must remain pure JavaScript.",
            "document": "The solution replaces the lexer with a Rust native extension.",
        },
        {
            "id": "duplicate_yes",
            "instruction": duplicate_instruction,
            "query": "Store transient tokens as source offsets and materialize them lazily.",
            "document": "Represent temporary tokens as source ranges and allocate only final AST nodes.",
        },
        {
            "id": "duplicate_no",
            "instruction": duplicate_instruction,
            "query": "Store transient tokens as source offsets and materialize them lazily.",
            "document": "Memoize ambiguous grammar predicates at each source position.",
        },
        {
            "id": "chinese_yes",
            "instruction": requirement_instruction,
            "query": "必须保持公开 API 不变。",
            "document": "这个方案保持所有公开 API 完全不变，只修改内部实现。",
        },
        {
            "id": "chinese_no",
            "instruction": requirement_instruction,
            "query": "必须保持公开 API 不变。",
            "document": "这个方案删除旧 API，改成新的异步 API。",
        },
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:4877/v1/score")
    args = parser.parse_args()
    body = json.dumps({"items": build_items(), "batch_size": 6}).encode("utf-8")
    request = urllib.request.Request(
        args.url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)

    scores = {item["id"]: item["score"] for item in payload["scores"]}
    comparisons = [
        ("requirement", scores["requirement_yes"], scores["requirement_no"]),
        ("duplicate", scores["duplicate_yes"], scores["duplicate_no"]),
        ("chinese", scores["chinese_yes"], scores["chinese_no"]),
    ]
    failed = False
    for name, positive, negative in comparisons:
        margin = positive - negative
        print(f"{name:11} positive={positive:.4f} negative={negative:.4f} margin={margin:.4f}")
        failed = failed or positive <= negative or margin < 0.5
    print(
        f"device={payload['device']} duration_ms={payload['duration_ms']} "
        f"input_tokens={payload['input_tokens']}"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
