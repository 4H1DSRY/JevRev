# JevRev Design

Status: MVP design baseline

## Product promise

An agent receives a goal, proposes several materially different approaches,
and calls JevRev before it spends implementation budget. JevRev asks Jev a
batch of narrow questions, applies deterministic policy, and returns the small
set worth trying.

The user stays in Codex, Claude Code, or another coding agent. JevRev is a
decision primitive called by that agent, not a replacement agent and not a
workflow dashboard.

```text
User goal
   -> agent creates typically 3-7 cards (protocol permits 2-12)
   -> JevRev asks narrow typed questions in one Jev request
   -> deterministic gates remove bad and duplicate candidates
   -> agent implements only the survivors
```

## MVP boundary

Included:

- A stable JSON input/output contract.
- Candidate-card validation.
- One batched Jev request per ranking run.
- Atomic judgments for goal fit, constraints, feasibility, validation quality,
  execution value, and pairwise duplication.
- Deterministic scoring, hard gates, diversity pruning, and budget cutoff.
- Human-readable and JSON output.
- Replayable responses for demos and tests without an API key.
- A Codex skill that teaches an agent when and how to call the CLI.

Deferred:

- Generating candidates. The host agent already does this well.
- Implementing candidates or managing worktrees.
- Running tests, benchmarks, screenshots, or merging a winner.
- Long-running agent audits and completion scoring.
- A web UI, hosted service, or persistent run database.

This separation is intentional. Candidate pruning must prove useful before it
becomes an orchestration framework.

## Product invariants

1. Jev never gets authority over deterministic facts. Code owns budgets,
   thresholds, arithmetic, candidate limits, and schema validation.
2. Jev does not generate explanations. It returns typed probabilities. The CLI
   emits reason codes derived from policy; the host agent may explain them.
3. One broad "which plan is best?" question is not sufficient. Each candidate
   is assessed on narrow dimensions.
4. A candidate is a structured proposal, not a title. It must state a mechanism,
   assumptions, risks, and a validation plan.
5. Uncertainty does not become rejection. Low-confidence decisions are routed
   to review.
6. Similar candidates do not consume separate implementation slots.
7. JSON mode writes only protocol output to stdout. Diagnostics go to stderr.

## Modules

### `domain`

Owns public schemas and stable types. It validates bounds, identifiers, unique
candidate IDs, and references. It contains no provider or CLI logic.

### `questions`

Turns a validated request into a TypeSafe System One state and a batch of typed
questions. Every instruction names an explicit `candidates[index]` path because
question IDs are not visible to Jev.

### `judge`

Defines a narrow provider boundary. `TypeSafeJudge` uses the official SDK;
`SemIfJudge` sends one typed question at a time to a local llama.cpp server and
normalizes the declared option-token logits; `LocalJudge` keeps the older
0.6B reranker compatibility path; `ReplayJudge` reads a captured response.
None of the providers decides which candidates live.

### `policy`

Normalizes Jev answers into comparable signals and applies all deterministic
rules. Its inputs and outputs are pure data, so it can be tested exhaustively.

### `report`

Renders either stable JSON or concise terminal output. It maps reason codes to
plain labels but does not invent model reasoning.

### `cli`

Handles files/stdin, flags, exit codes, provider selection, and error mapping.
It contains no ranking math.

## Ranking policy

Each candidate receives five semantic signals in `[0, 1]`:

| Signal | Weight | Meaning |
| --- | ---: | --- |
| goal fit | 0.30 | Expected ability to reach the stated success criteria |
| constraint fit | hard gate + 0.20 | Expected compliance with hard constraints |
| feasibility | 0.20 | Technical credibility with the supplied context |
| validation quality | 0.10 | Whether the claimed gain can be falsified cheaply |
| execution value | 0.20 | Whether the candidate merits implementation budget |

Declared implementation effort applies a small deterministic multiplier. It
must not overpower goal fit or hard constraints.

Policy proceeds in this order:

1. Route candidates with insufficient answer confidence to review.
2. Reject sufficiently confident candidates that clearly fail a semantic gate.
3. Sort eligible candidates by composite score.
4. Walk the sorted list and reject candidates highly likely to duplicate an
   already-kept candidate.
5. Keep at most `max_survivors`; reject remaining eligible candidates with a
   budget-cutoff reason.

Thresholds are versioned and included in every result. Defaults are product
policy, not hidden model behavior.

The result's aggregate `confidence` is the minimum of all five signal
confidences. Score questions use Jev's reported confidence. Noul questions do
not include a separate confidence field, so policy uses their distance from
`0.5` as a decision-margin proxy. This derived value is product policy, not a
field claimed to come from Jev.

## Failure behavior

- Invalid input: fail before making an API request.
- Missing API key: fail with setup guidance unless `--replay` is used.
- Provider timeout/rate limit: the official SDK retry policy applies; exhausted
  failures return a distinct provider exit code.
- Missing/malformed answers: fail closed with a protocol error; never silently
  substitute neutral scores.
- No survivor: return a valid result with an empty `selected` array. The agent
  should generate better candidates or ask the user.

## Security and privacy

JevRev sends the serialized task and candidate cards to TypeSafe. It does not
need repository contents, source files, diffs, environment variables, or tool
logs. Agent instructions must summarize only the context required to judge the
candidate mechanisms and must not include secrets.

## Later extension

The future long-run harness should reuse only the provider and typed-decision
infrastructure. It should introduce a separate `EvidencePacket` and audit state
machine instead of overloading the candidate-ranking protocol.
