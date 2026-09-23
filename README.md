<p align="center">
  <img src=".github/assets/jevrev-banner.png" alt="JevRev" width="100%" />
</p>

<h1 align="center">JevRev</h1>

<p align="center"><strong>Explore wide. Prove cheap. Commit once.</strong></p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/jevrev"><img alt="npm version" src="https://img.shields.io/npm/v/jevrev?style=flat-square" /></a>
  <a href="package.json"><img alt="Node.js 20 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-F4C430?style=flat-square" /></a>
</p>

An agent can generate ten plausible ways to solve a problem. It should not spend
the same implementation budget on all ten.

JevRev is an open-source runtime for composing, executing, verifying, and
observing intelligent workflows. JevSift, Probe/Decide, JevLoop, and JevLong
are the four layers of the current release.

JevRev gives the expensive model room to think and build, then puts a smaller,
cheaper decision layer in front of the irreversible work. Jev filters the
search. Commands, tests, benchmarks, hashes, and budgets decide what is true.

```text
agent proposes  ->  JevRev narrows  ->  host agent probes  ->  evidence decides
                                                                  |
                                             Loop keeps one artifact moving
                                             Long watches the session
```

JevRev is not another coding agent. It does not quietly take over a terminal,
create a worktree, merge a branch, or keep running after the host agent stops.
It is a set of explicit workflows that an agent can call from the command line.

## The useful failure

The included workflow demo starts with a tempting shortcut: a regex parser that
looks much faster on paper. The same candidate then runs correctness checks and
repeated benchmark samples. The shortcut fails correctness. A slower state
machine survives the checks and becomes the only integration candidate.

![JevRev sends a paper favorite through an evidence gate and leaves the verified implementation standing.](.github/assets/jevrev-decision-gate.svg)

Run the case yourself:

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run demo:workflow
```

The demo executes both implementations. Jev answers are replayed so the route
is deterministic; command exits, correctness results, raw samples, output
digests, and the final decision are real. Throughput is machine-dependent. The
important result is the reversal: the fastest-looking plan is rejected by its
own evidence.

## A small proof, stated honestly

The included candidate-coverage benchmark rotates the input order. A naive
workflow that takes the first idea is therefore easy to move around; the Sift
shortlist is evaluated against the same predeclared scenario rubric.

| Scenario | First idea quality, mean ± sample σ | Sift shortlist quality, mean | Cards not sent to implementation |
| --- | ---: | ---: | ---: |
| Parser speedup | `0.550 ± 0.382` | `0.975` | `5 / 7` |
| API boundary hardening | `0.412 ± 0.385` | `0.850` | `4 / 6` |
| Flaky CI concurrency | `0.433 ± 0.448` | `0.975` | `4 / 6` |

The σ column is the sample standard deviation (`n - 1`) across candidate-order
rotations. These are declared scenario labels, not a claim about production
defect rates, engineering hours, or universal model stability. The point is
smaller and more useful: a first guess is sensitive to ordering, while a
shortlist gives the host agent a repeatable set of things worth probing.

## What ships

| Layer | What it does | Command |
| --- | --- | --- |
| **JevSift** | Prunes materially different proposals and emits bounded work orders | `jevrev sift` |
| **Probe + Decide** | Records commands, metrics, artifacts, and revisions, then chooses the next route | `jevrev evidence`, `jevrev decide` |
| **JevLoop** | Audits one evolving artifact after each host-agent round | `jevrev loop` |
| **JevLong** | Observes a long-running session for stalls, failures, drift, budget risk, and progress | `jevrev long` |

The layers share schemas, provider adapters, budgets, and evidence rules, but
they do not share authority. Sift does not claim that a proposal works. Decide
does not run arbitrary code. Loop returns the next action but does not drive the
agent. Long raises attention but never stops or steers the session.

## Quick start

Install the CLI:

```bash
npm install -g jevrev
```

Then install the agent skill for Codex or another supported host:

```bash
jevrev-skill-install --target codex
```

Give the host agent one instruction:

```text
Use JevRev for this task. Propose materially different approaches, sift them,
run only the bounded probes, record raw evidence, decide from that evidence,
and stop before merging.
```

For a no-network smoke test, use the checked-in replay fixtures:

```bash
jevrev run \
  --input examples/parser-speedup.json \
  --replay examples/parser-jev-response.json \
  --format human
```

## The normal workflow

### 1. Propose a few real alternatives

The host agent creates 3-7 candidate cards. Each card has a mechanism,
assumptions, risks, and a way to falsify it. Simple fixes should skip JevRev.

### 2. Sift before spending implementation budget

```bash
jevrev sift --input proposals.json --provider jev > campaign.json
```

Each survivor gets a hypothesis, the smallest useful probe, required evidence,
a budget, and stop conditions. The default policy removes hard-constraint
violations, low-confidence paths, duplicates, and candidates that do not merit
an implementation slot.

### 3. Execute only the bounded probes

The host agent owns the worktree and the commands. JevRev records exactly what
ran without invoking a shell:

```bash
jevrev-evidence-template --campaign campaign.json --output evidence.json
jevrev evidence run \
  --evidence evidence.json \
  --candidate candidate-id \
  --id tests \
  -- npm test
jevrev evidence metric \
  --evidence evidence.json \
  --candidate candidate-id \
  --input throughput.json
jevrev evidence status --campaign campaign.json --evidence evidence.json
```

Recorded exit codes, raw samples, workspace-bound artifacts, candidate hashes,
and revision identity are stronger evidence than builder notes. Recorder output
is quiet by default; link the observation to the exact probe or requirement IDs
from `campaign.json` when you have them. Use `--echo` only when you intentionally
want child output in the terminal.

### 4. Decide from evidence

```bash
jevrev decide \
  --campaign campaign.json \
  --evidence evidence.json \
  --provider jev
```

Deterministic gates run first. A failed required command or hard constraint
cannot be rescued by a high Jev score. The result is one of:

```text
winner       ready for human review before integration
merge        two candidates deserve one combined probe
probe_more   evidence is missing or the leaders are too close
no_winner    every candidate failed a deterministic or semantic gate
human_review the trade-off needs a person
```

## Loop: one artifact, no fake finish line

JevLoop is for a host agent that is already editing one artifact. It has no
fixed round count and no score threshold that can declare success. Only fresh,
current-head evidence can complete a frozen contract.

```bash
jevrev loop create \
  --directory .jevrev/parser-loop \
  --spec examples/loop-parser-spec.json \
  --base-revision "$(git rev-parse HEAD)"
jevrev loop next \
  --directory .jevrev/parser-loop \
  --plan examples/loop-parser-plan.json \
  --format json
jevrev loop audit \
  --directory .jevrev/parser-loop \
  --evidence round-evidence.json \
  --replay examples/loop-parser-replay.json
```

The host agent performs the work. The human owns contract changes, resume,
abort, and integration.

## Long: watch the session, do not drive it

JevLong consumes bounded JSONL events and keeps a local hash-chained journal. It
reports stalls, repeated failures, drift, budget risk, and evidence-backed
progress. It is an observer, not a hidden daemon or a control panel.

```bash
jevrev long create \
  --directory .jevrev/long \
  --spec examples/long-session-spec.json \
  --format json
jevrev long ingest \
  --directory .jevrev/long \
  --input examples/long-events.jsonl
jevrev long status --directory .jevrev/long --format json
jevrev long watch --directory .jevrev/long --interval-ms 1000
```

The watch cockpit shows overview, activity, alerts, and evidence. It never
retries, stops, edits, kills, or advances the observed agent.

## Jev providers

The same typed decision boundary works with a hosted Jev, a local SemIf model,
the legacy local scorer, or a replay file:

| Provider | Use it when | Endpoint |
| --- | --- | --- |
| Hosted Jev | You want the managed decision layer | `https://api.typesafe.ai/v1/systemone` |
| Local SemIf | You want local inference through llama.cpp | `http://127.0.0.1:4878/v1/chat/completions` |
| Legacy local | You already run the compatible reranker | `http://127.0.0.1:4877/v1/score` |
| Replay | You need deterministic offline development | local response JSON |

Hosted credentials are read from the environment, never from command-line
arguments:

```bash
export JEVREV_JEV_API_KEY="..."
jevrev doctor --format json
jevrev sift --input proposals.json --provider jev
```

For the local path, the tested setup uses Qwen3.5-4B GGUF behind llama.cpp:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
jevrev doctor --provider semif --format json --check
jevrev sift --input proposals.json --provider semif
```

See [`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md) for model setup and sizing.

## Same brief, different result

JevRev can route a whole artifact, not just a line of code. The repository
includes a four-direction one-shot showcase: a conventional first pass and a
JevRev-routed evidence dossier from the same frozen brief.

<table>
  <tr>
    <th width="50%">Direct path</th>
    <th width="50%">JevRev path</th>
  </tr>
  <tr>
    <td><img src=".github/assets/one-shot-showcase/direct-hero.png" alt="Direct first-pass page" /></td>
    <td><img src=".github/assets/one-shot-showcase/routed-hero.png" alt="JevRev-routed page" /></td>
  </tr>
</table>

This is a controlled showcase, not a claim of universal design quality or
business lift. Reproduce its checks with:

```bash
npm run demo:oneshot
```

## Why the split matters

The expensive model is good at generating possibilities and doing difficult
implementation work. It is a poor use of that budget to ask it to make every
cheap routing decision, inspect every repeated event, or keep choosing between
the same failed paths.

JevRev puts those decisions behind small typed contracts:

- the host agent proposes and executes;
- Jev gives narrow semantic judgements;
- commands, tests, measurements, hashes, and budgets provide facts;
- JevRev enforces state transitions;
- a human changes the contract and decides what gets integrated.

That is the whole idea: not one giant pipe, but a system with a fast lower
layer and an expensive upper layer used where it earns its cost.

## Project status

| Area | Status |
| --- | --- |
| JevSift and replay workflow | Shipped |
| Evidence recorder, metrics, artifacts, and Decide | Shipped |
| JevLoop single-artifact protocol | Shipped |
| JevLong local observer and watch cockpit | Shipped |
| Automatic worktrees, merge automation, hidden daemon | Not part of the product |
| Durable Long acknowledgement/close commands and optional Jev observer | Reserved follow-up contracts |

## Documentation

| Question | Document |
| --- | --- |
| How does the end-to-end workflow work? | [`docs/WORKFLOW.md`](docs/WORKFLOW.md) |
| What are the JSON schemas and exit codes? | [`docs/PROTOCOL.md`](docs/PROTOCOL.md) |
| How are permissions divided? | [`docs/AUTHORITY.md`](docs/AUTHORITY.md) |
| What is the JevLoop contract? | [`docs/JEVLOOP_DESIGN.md`](docs/JEVLOOP_DESIGN.md) |
| What is the JevLong contract? | [`docs/JEVLONG_DESIGN.md`](docs/JEVLONG_DESIGN.md) |
| What has been tested? | [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) |
| How does local SemIf setup work? | [`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md) |

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

Node.js 20 or newer is required. Generated benchmark results and credentials
are excluded from the package.

## License

[MIT](LICENSE)
