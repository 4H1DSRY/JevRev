# JevRev Protocol v1

## Input

The CLI accepts one JSON object from `--input <path>` or stdin (`--input -`).

```json
{
  "version": "1",
  "task": {
    "goal": "Make the parser at least 2x faster.",
    "context": "The parser is single-threaded TypeScript.",
    "constraints": [
      { "id": "api", "text": "Do not change the public API", "kind": "hard" }
    ],
    "success": [
      { "id": "speed", "text": "Benchmark throughput is at least 2.0x baseline" }
    ]
  },
  "budget": { "max_survivors": 2 },
  "candidates": [
    {
      "id": "byte-fast-path",
      "title": "Add a byte-level fast path",
      "summary": "Bypass token objects for common ASCII input.",
      "mechanism": "Parse common ASCII tokens directly from the input buffer.",
      "assumptions": ["ASCII-heavy input dominates the benchmark corpus"],
      "risks": ["Fast and slow paths may diverge semantically"],
      "validation": ["Run the existing suite against both paths", "Benchmark the corpus"],
      "effort": "medium"
    },
    {
      "id": "allocation-cut",
      "title": "Reduce hot-path allocations",
      "summary": "Reuse bounded temporary storage on the measured hot path.",
      "mechanism": "Pool temporary arrays with reset-on-parse ownership and retain the existing fallback path.",
      "assumptions": ["Allocation pressure is a measured bottleneck"],
      "risks": ["State could leak between parses"],
      "validation": ["Run the full test suite", "Compare allocation counts and throughput"],
      "effort": "small"
    }
  ]
}
```

Rules:

- `version` must be `"1"`.
- Candidate and criterion IDs use lowercase letters, digits, `_`, and `-`.
- Candidate IDs must be unique.
- A request contains 2-12 candidates.
- `max_survivors` cannot exceed the number of candidates.
- Free-text fields are length-bounded to keep the Jev state focused.

## Output

JSON mode returns one object:

```json
{
  "version": "1",
  "run_id": "jvr_...",
  "model": "jev-1.13.0",
  "policy": { "name": "default-v1", "max_survivors": 2 },
  "summary": { "evaluated": 7, "kept": 2, "shortlisted": 2, "review": 0, "rejected": 5 },
  "selected": ["byte-fast-path", "allocation-cut"],
  "shortlist": ["byte-fast-path", "allocation-cut"],
  "decisions": [
    {
      "candidate_id": "byte-fast-path",
      "status": "keep",
      "rank": 1,
      "score": 0.82,
      "confidence": 0.76,
      "signals": {
        "goal_fit": 0.85,
        "constraint_fit": 0.91,
        "feasibility": 0.79,
        "validation_quality": 0.88,
        "execution_value": 0.74
      },
      "reasons": []
    }
  ],
  "usage": { "input_tokens": 1200, "output_tokens": 300 }
}
```

Statuses:

- `keep`: eligible for implementation.
- `review`: uncertain; an agent or human must decide.
- `reject`: do not spend implementation budget under the current policy.

Reason codes:

- `GOAL_MISMATCH`
- `CONSTRAINT_RISK`
- `LOW_FEASIBILITY`
- `WEAK_VALIDATION`
- `LOW_EXECUTION_VALUE`
- `LOW_CONFIDENCE`
- `DUPLICATE_CANDIDATE` with a related candidate ID
- `BUDGET_CUTOFF`

Reason codes identify the rule that fired. They are not chain-of-thought or a
natural-language explanation from Jev.

`confidence` is a routing value computed by JevRev. It combines Jev's Score
confidence with the decision margin of Noul probabilities; it is not an extra
confidence field returned for Noul questions.

## Provider addresses

The live Jev adapter calls `POST https://api.typesafe.ai/v1/systemone` by
default. Set `--jev-url` or `JEVREV_JEV_URL` to replace the API root. The API
key is read from `JEVREV_JEV_API_KEY` or the compatible `TYPESAFE_API_KEY`.

The local adapters use `POST /v1/chat/completions` on the SemIf base URL
(`http://127.0.0.1:4878` by default), or `POST /v1/score` on the legacy local
reranker (`http://127.0.0.1:4877`). `jevrev doctor --format json` prints the
resolved addresses without making an authenticated Jev request.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Ranking completed, including a valid result with zero survivors |
| 2 | Invalid input or CLI usage |
| 3 | Judge provider/authentication/network failure |
| 4 | Judge response violated the expected protocol |
| 1 | Unexpected internal failure |
