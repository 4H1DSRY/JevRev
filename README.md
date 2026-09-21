<p align="center">
  <img src=".github/assets/jevrev-banner.png" alt="JevRev banner" width="100%" />
</p>

<h1 align="center">JevRev</h1>

<p align="center"><strong>Explore wide. Prove cheap. Commit once.</strong></p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square" /></a>
  <a href="package.json"><img alt="Node.js 20 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-F4C430?style=flat-square" /></a>
</p>

> Explore wide. Prove cheap. Commit once.

Coding agents are good at finding plausible ways forward. They are less good at
noticing when the first plausible way is merely the first one they wrote down.

JevRev gives an agent a small speculative-engineering funnel:

```text
4-7 ideas
   ↓  Jev sifts proposals
2 bounded probes
   ↓  tests and benchmarks produce evidence
winner / merge probe / more evidence / no winner
```

It is a CLI, not another coding agent. Codex, Claude Code, or your own harness
still generates and implements the alternatives. JevRev freezes the brief,
prunes weak directions, issues comparable work orders, validates the returned
evidence, and makes the final route explicit.

## The part that matters

A plan score is not proof. JevRev uses two different decisions:

1. **Sift** asks whether a proposed mechanism is plausible, distinct, feasible,
   testable, and worth a probe.
2. **Decide** starts with command exits, requirement results, raw metric samples,
   revision identity, and budgets. Jev then judges evidence coverage,
   reproducibility, residual risk, and shipping value.

A failed required test cannot be rescued by a high model score. The final result
can be `winner`, `merge`, `probe_more`, `no_winner`, or `human_review`.

That distinction is the product.

## See the ranking reverse

The bundled workflow demo is offline and deterministic:

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run demo:workflow
```

```text
JevRev workflow demo — executed ranking reversal
Paper favorite: regex-shortcut (sift score 0.9593)
  measured throughput: 65.10x baseline
  correctness command: failed
  result: rejected
Evidence winner: indexed-state-machine
  measured throughput: 5.20x baseline
  correctness command: passed
Decision: winner -> integrate_winner
```

Throughput varies by machine. The demo actually executes both implementations'
correctness probes and seven-sample benchmarks; only the Jev Sift/Decide answers
are replayed so the routing policy stays deterministic. The deliberately
tempting regex is much faster but counts quoted delimiters incorrectly, so the
slower verified state machine wins. Campaign, raw evidence, output digests,
source hashes, replays, and the final decision are written under
`benchmarks/results/workflow-demo/`.

## Use it from an agent

The normal entry point is a short instruction to the coding agent:

```text
Use JevRev for this task. Generate materially different hypotheses, run `jevrev
sift`, perform only the returned probes in isolation, record raw test and
benchmark evidence, then run `jevrev decide`. Stop before merging.
```

JevRev also ships a file-based agent skill:

```bash
npm install -g jevrev
jevrev-skill-install --target codex
```

The skill keeps JSON plumbing out of the user's conversation. It teaches the
host agent when the workflow is worth using and when a simple direct edit is
cheaper.

## CLI

### 1. Sift the ideas

The input is a frozen brief plus 2-12 structured candidate cards. See
[`examples/parser-speedup.json`](examples/parser-speedup.json) for a complete
request.

```bash
jevrev sift --input proposals.json --provider jev > campaign.json
```

Each strict survivor receives a work order containing:

- the hypothesis;
- a smallest-probe instruction;
- required evidence;
- wall-time and changed-file budgets;
- stop conditions.

`run` and `rank` remain available as the original one-pass shortlist primitive:

```bash
jevrev run --input proposals.json --provider jev
```

### 2. Probe in isolation

The host agent implements the work orders in branches or worktrees. JevRev does
not execute arbitrary commands or merge code in this release.

Evidence packets record raw facts rather than a success story:

- base/head revision and optional diff digest;
- command argv, exit code, duration, and output digests;
- baseline and candidate metric samples;
- a result for each success criterion and hard constraint;
- changed files, time, optional tokens/cost, and known failures.

Passing requirements must cite recorded observations or metrics. Candidate and
campaign hashes prevent evidence from being attached to the wrong proposal.

### 3. Decide from evidence

```bash
jevrev decide \
  --campaign campaign.json \
  --evidence evidence.json \
  --provider jev
```

The policy applies facts first:

```text
schema and hashes
→ required commands and hard constraints
→ metric summaries recomputed from raw samples
→ Jev evidence review
→ deterministic outcome
```

For an offline replay:

```bash
jevrev decide \
  --campaign campaign.json \
  --evidence evidence.json \
  --replay decide-response.json
```

The full state, trust model, and acceptance criteria are in
[`docs/WORKFLOW.md`](docs/WORKFLOW.md). Wire formats and exit codes are in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Providers

### Hosted Jev

```bash
export JEVREV_JEV_API_KEY="..."
jevrev sift --input proposals.json --provider jev
```

Default request: `POST https://api.typesafe.ai/v1/systemone`

Override the root with `--jev-url` or `JEVREV_JEV_URL`. The compatibility names
`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, and `TYPESAFE_DEFAULT_MODEL` remain
supported. Credentials are read from the environment and are never accepted as
CLI arguments.

### Local SemIf

The tested local path uses a Qwen3.5-4B GGUF behind llama.cpp:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
jevrev sift --input proposals.json --provider semif
```

Default request: `POST http://127.0.0.1:4878/v1/chat/completions`

The legacy reranker remains available at `http://127.0.0.1:4877/v1/score` with
`--provider local`. Run `jevrev doctor --format json --check` to inspect the
configured endpoints. Local setup is documented in
[`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md).

All four modes—Jev, SemIf, legacy local, and replay—support both Sift and Decide.

## What JevRev does not do

JevRev does not:

- force several ideas onto an obvious one-line fix;
- build five complete products just to compare them;
- treat a judge probability as ground truth;
- trust builder notes as evidence;
- run arbitrary shell commands in the current release;
- merge a branch or modify the user's repository;
- force a winner when every probe fails.

Use it when wrong-path regret is larger than the cost of two small probes. Skip
it when the solution is obvious or cheap to reverse.

## One-pass benchmark record

Before the evidence workflow existed, the Sift primitive was exercised on three
local Qwen3.5-4B scenarios with cyclic candidate-order rotations. In that fixed
run, the sample standard deviation of naive first-choice utility was 0.382,
0.385, and 0.448; the returned shortlist's best utility was unchanged across
the same rotations. This measures order sensitivity, not general model quality
or engineering time saved.

The exact method, sample counts, token overhead, and limitations are preserved
in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md). New users should start with the
ranking-reversal workflow demo above; it shows the more important distinction
between proposal quality and empirical evidence.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run demo:all
npm run demo:workflow
npm pack --dry-run
```

Node.js 20 or newer is required. Generated benchmark artifacts and credentials
are excluded from the package.

## License

[MIT](LICENSE)
