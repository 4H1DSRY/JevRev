# JevRev

<p align="center">
  <img src=".github/assets/jevrev-banner.png" alt="JevRev" width="100%" />
</p>

<p align="center"><strong>The decision layer beside your LLM.</strong></p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square" /></a>
  <a href="package.json"><img alt="Node.js 20 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-F4C430?style=flat-square" /></a>
</p>

Your LLM can imagine, write, test, and revise. It should not have to make every
cheap routing decision by itself.

JevRev puts Jev beside the LLM: a fast, low-cost semantic layer that filters
plans, checks progress, and keeps attention on the work worth continuing. The
LLM supplies breadth and implementation power. JevRev supplies the second look
before more time and tokens are spent.

```text
LLM + agent
    |
    +--> JevSift  ------------ choose the paths worth trying
    |
    +--> JevLoop  ------------ improve one artifact, round by round
    |       host agent probes -> evidence recorder -> Jev audit -> next action
    |
    +--> JevLong ------------- watch the long-running session
```

That is JevRev: not another coding agent, but the decision system around one.
`Probe`, `Evidence`, and `Decide` are the shared protocol and infrastructure
underneath these three parts, not extra products.

## See the idea

The included case asks for a faster CSV parser. The LLM proposes a tempting
regex shortcut and a more careful state machine. The shortcut wins the paper
ranking, then fails the correctness check. The state machine is slower, passes
the same checks, and becomes the evidence winner.

![JevRev routes a paper favorite through correctness evidence and keeps the verified implementation.](.github/assets/jevrev-decision-gate.svg)

Run the complete case:

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run build
npm run demo:workflow
```

The Jev answers are replayed for a deterministic demo. The implementations,
correctness checks, benchmark samples, output digests, and final decision are
real:

```text
Paper favorite: regex-shortcut
  correctness command: failed
  result: rejected

Evidence winner: indexed-state-machine
  correctness command: passed
Decision: winner -> integrate_winner
```

## The three parts

### JevSift: choose the work

The host LLM proposes a few materially different approaches. JevSift removes
weak, duplicate, risky, or low-value paths before they consume implementation
budget, then emits bounded work orders for the survivors.

### JevLoop: improve one artifact

The host agent executes a bounded work order, records what actually happened,
and submits the round to JevLoop. Loop checks the evidence, asks Jev only the
narrow questions that facts cannot settle, and returns the next action: continue,
fix, verify, replan, wait for a human, or finish when every criterion is proven.

This is where `Probe`, `Evidence`, and `Decide` belong in the product story:
they are Loop's working machinery, not another product surface.

### JevLong: watch the session

JevLong observes a long-running agent session and reports stalls, repeated
failures, drift, tool-call problems, budget risk, and progress to a human. It
does not silently steer, retry, edit, or kill the agent.

The result is a simple split: the LLM does the expensive creative work, while
JevRev prevents the workflow from repeatedly paying for bad directions.

## Use it from Codex

Build the CLI and install the bundled skill into Codex:

```bash
npm install
npm run build
node scripts/install-skill.mjs --target codex
```

Then give the host agent this instruction:

```text
Use JevRev for this task. Propose materially different approaches, ask JevRev
to sift them, run only the bounded probes, record the evidence, and let JevRev
audit the next round before continuing.
```

## The command surface

| Command | Role in the LLM + Jev workflow |
| --- | --- |
| `jevrev sift` | Decide which proposed approaches deserve a probe |
| `jevrev loop` | Audit one artifact after each agent round |
| `jevrev long` | Observe the health of a long-running session |

`jevrev evidence` and `jevrev decide` are lower-level infrastructure commands.
They record and adjudicate the facts that JevSift and JevLoop consume; they are
not a fourth and fifth product component.

From source, use `node dist/cli.js` in place of `jevrev`:

```bash
node dist/cli.js sift --input proposals.json --replay examples/parser-jev-response.json
```

## Providers

JevRev keeps the decision boundary the same whether Jev is hosted, local, or
replayed:

```bash
# Hosted Jev
export JEVREV_JEV_API_KEY="..."
node dist/cli.js sift --input proposals.json --provider jev

# Local SemIf through llama.cpp
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
node dist/cli.js sift --input proposals.json --provider semif
```

Replay fixtures work without a network or API key. See
[`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md) for the local model setup.

## One brief, two outcomes

JevRev is useful beyond code paths. The repository includes two pages made from
the same brief: a conventional first pass and a JevRev-routed evidence dossier.

<table>
  <tr>
    <th width="50%">First pass</th>
    <th width="50%">JevRev route</th>
  </tr>
  <tr>
    <td><img src=".github/assets/one-shot-showcase/direct-hero.png" alt="Conventional first-pass page" /></td>
    <td><img src=".github/assets/one-shot-showcase/routed-hero.png" alt="JevRev-routed evidence dossier" /></td>
  </tr>
</table>

The point is not a magic visual score. It is that the route chosen by Jev can
change the artifact's structure, evidence, and final direction together.

## Read next

- [Workflow guide](docs/WORKFLOW.md)
- [Protocol and JSON contracts](docs/PROTOCOL.md)
- [Authority model](docs/AUTHORITY.md)
- [JevLoop design](docs/JEVLOOP_DESIGN.md)
- [JevLong design](docs/JEVLONG_DESIGN.md)
- [Acceptance record](docs/ACCEPTANCE.md)

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
