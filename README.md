# JevRev

<p align="center">
  <img src=".github/assets/jevrev-banner.png" alt="JevRev" width="100%" />
</p>

<p align="center"><strong>Explore wide. Prove cheap. Commit once.</strong></p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/jevrev"><img alt="npm version" src="https://img.shields.io/npm/v/jevrev?style=flat-square" /></a>
  <a href="package.json"><img alt="Node.js 20 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-F4C430?style=flat-square" /></a>
</p>

JevRev is a command-line toolkit for coding agents. It helps an agent explore
several approaches, test the survivors, and keep the result it can actually
verify.

The expensive model does the work that needs judgment. JevRev handles the
cheaper decisions around it: which paths are worth probing, what the evidence
supports, whether a round should continue, and whether a long session needs a
human to look at it.

```text
ideas -> sift -> bounded probes -> evidence -> decision
                                      |
                         loop one artifact / long one session
```

JevRev does not run an agent in the background, merge branches, or turn a model
score into proof.

## Try it

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run demo:workflow
```

The demo compares two parser implementations. The regex shortcut wins on paper,
then fails its correctness check. The state machine is slower but passes and is
returned as the evidence winner.

```text
Paper favorite: regex-shortcut
  correctness command: failed
  result: rejected

Evidence winner: indexed-state-machine
  correctness command: passed
Decision: winner -> integrate_winner
```

The Jev response is replayed so the routing is deterministic. The commands,
correctness checks, benchmark samples, and evidence hashes are real. Inspect the
generated files in `benchmarks/results/workflow-demo/`.

## Install

```bash
npm install -g jevrev
jevrev-skill-install --target codex
```

Then tell the host agent:

```text
Use JevRev for this task. Propose materially different approaches, sift them,
run only bounded probes, record raw evidence, decide from that evidence, and
stop before merging.
```

## How it works

1. The host agent proposes a few materially different approaches.
2. `jevrev sift` removes weak, risky, duplicate, or low-value paths and emits
   bounded work orders.
3. The host agent runs the work orders and records commands, metrics, artifacts,
   and revision identity.
4. `jevrev decide` checks deterministic evidence first, then asks Jev only the
   narrow questions that remain.

A failed required command or hard constraint cannot be rescued by a high Jev
score. A winner is a recommendation for human review, not an automatic merge.

## Commands

| Command | Use |
| --- | --- |
| `jevrev sift` | Shortlist approaches before implementation work |
| `jevrev evidence` | Record command, metric, and artifact evidence |
| `jevrev decide` | Choose `winner`, `merge`, `probe_more`, `no_winner`, or `human_review` |
| `jevrev loop` | Audit one evolving artifact after each agent round |
| `jevrev long` | Observe a long-running session without driving it |

Sift, evidence, and Decide form the main path. Loop and Long are explicit
workflows for teams that need a round boundary or a session observer; neither
starts, stops, retries, edits, or kills an agent.

## Providers

The decision boundary works with:

- hosted Jev;
- local SemIf through llama.cpp;
- the legacy local scorer;
- replay files for offline development.

Hosted credentials come from `JEVREV_JEV_API_KEY` or `TYPESAFE_API_KEY`, never
from command-line arguments. See [`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md)
for the local setup.

## Documentation

- [Workflow](docs/WORKFLOW.md)
- [Protocol](docs/PROTOCOL.md)
- [Authority model](docs/AUTHORITY.md)
- [JevLoop contract](docs/JEVLOOP_DESIGN.md)
- [JevLong contract](docs/JEVLONG_DESIGN.md)
- [Acceptance record](docs/ACCEPTANCE.md)

## Status

The Sift, evidence, Decide, Loop, and Long command paths are shipped. Automatic
worktree creation, merge automation, and a hidden daemon are deliberately out
of scope. Long acknowledgement/close commands and an optional Jev observer are
reserved follow-up contracts.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run demo:all
npm run demo:workflow
```

Node.js 20 or newer is required. JevRev is MIT licensed.

[MIT](LICENSE)
