---
name: jevrev
description: Use JevSift to narrow competing mechanisms, run bounded probes, and use recorded evidence to decide what to integrate.
---

# JevRev / JevSift

JevRev is the umbrella CLI. The currently implemented layers are:

- **JevSift**: `jevrev sift` (with `run`/`rank` compatibility aliases). It
  filters proposal cards and writes probe work orders. It does not prove code.
- **Probe/Decide**: `jevrev decide`. It checks evidence and asks Jev about
  evidence sufficiency and residual risk.
- **JevLoop** and **JevLong** are not implemented yet. Do not invent commands
  or imply that a normal Sift run is a long-running audit loop.

## When to use it

Use JevSift when:

- at least two materially different mechanisms could solve the task;
- a wrong path costs more than two bounded probes;
- success can be checked with tests, benchmarks, screenshots, or another
  falsifiable observation.

Skip it for an obvious one-line fix, a cheap reversible change, or a task whose
success criteria cannot be observed. Do not generate seven wording variants.

## Host-agent contract

The host agent owns the repository, worktrees, commands, and user conversation.
JevRev owns the frozen task contract, candidate routing, evidence schema, and
decision policy. Never send secrets, a whole repository, or untrusted logs to
Jev unless required by the task.

### Phase A — Freeze and Sift

1. State the goal, context, hard/soft constraints, success criteria, and probe
   budget. Freeze these before writing implementation code.
2. Draft 4–7 genuinely different candidate cards. Every card needs `id`,
   `title`, `summary`, `mechanism`, `assumptions`, `risks`, `validation`, and
   `effort`.
3. Write the request to a temporary file and run:

```bash
jevrev sift --input proposals.json --format json > campaign.json
```

4. Read `sift.selected` and `work_orders`. Do not implement rejected cards.
   A `review` card is not approved; ask a human or revise the ideas.

### Phase B — Execute work orders

For each work order, use a separate branch/worktree when practical. Perform the
smallest reversible probe, not a complete product. Use the same evidence shape
and comparable budgets for every finalist.

Record:

- the base and head revision, plus a diff/source hash;
- every command as direct argv, exit code, duration, and stdout/stderr digest;
- raw baseline and candidate metric samples (at least two samples each);
- a pass/fail/unknown result for every hard constraint and success criterion;
- a pass/fail/unknown result for every `required_evidence` ID in the work order;
- changed repository-relative files, wall time, optional token/cost usage;
- artifacts such as a diff, screenshot, or demo output by content hash;
- known failures. Builder notes are context, never proof.

If a command fails, record the failure. Do not change `required` to false to
make a failing observation disappear. Do not invent metric samples.

Use the trusted recorder for commands whenever possible:

```bash
jevrev evidence run \
  --evidence evidence.json \
  --candidate <candidate-id> \
  --id tests \
  --probe probe-1 \
  --requirement success:<criterion-id> \
  -- npm test
```

The command is executed as direct argv, not through a shell. Its exit code,
workspace-relative cwd, duration, output digests, byte counts, and termination
mode are saved before the recorder exits. A failed child command makes the
recorder exit nonzero but does not lose the recorded failure. Continue the
workflow by inspecting the evidence file, not by rerunning blindly.

Record raw benchmark samples with:

```bash
jevrev evidence metric \
  --evidence evidence.json \
  --candidate <candidate-id> \
  --input metric.json \
  --result pass \
  --probe probe-2 \
  --requirement success:<criterion-id>
```

Do not reduce samples to one claimed percentage. `metric.json` must contain raw
baseline and candidate arrays. Set `--result` by applying the frozen success
criterion, not merely because relative improvement is positive.

Record content-addressed artifacts and an imported evaluator result with
`jevrev evidence artifact`. Link an artifact to a requirement only when an
actual evaluator/status/summary is supplied; a file's existence is not proof.

Before Decide, always run:

```bash
jevrev evidence status --campaign campaign.json --evidence evidence.json
```

Proceed only when every intended finalist says `ready_for_decide`. For
`collect_evidence`, record exactly the missing item. For `revise_or_stop`, do
not spend more budget without user direction.

To avoid hand-writing the envelope, create an explicitly incomplete template:

```bash
jevrev-evidence-template --campaign campaign.json --output evidence.json
```

The template contains `unknown` statuses and a `TEMPLATE` failure marker. It
must be filled with actual observations before Decide.

### Phase C — Decide

```bash
jevrev decide \
  --campaign campaign.json \
  --evidence evidence.json \
  --format json > decision.json
```

Facts are applied before Jev:

1. campaign/candidate hashes, revision identity, paths, and references;
2. required command exit codes, hard constraints, budgets, and metric samples;
3. Jev evidence-support, reproducibility, residual-risk, and shipping-value
   questions;
4. deterministic outcome policy.

Follow the result exactly:

- `winner` / `integrate_winner`: show evidence and ask before applying/merging;
- `merge` / `probe_combination`: run a combined probe; do not merge yet;
- `probe_more` / `collect_evidence`: collect only missing/discriminating data;
- `no_winner` / `revise_ideas`: discard failed paths and generate new cards;
- `human_review` / `ask_human`: present the unresolved trade-off.

Never turn `merge` into permission to merge. Never treat a Sift score as proof.

## Provider setup

Hosted Jev:

```bash
export JEVREV_JEV_API_KEY="..."
jevrev sift --input proposals.json --provider jev
```

Local SemIf:

```bash
jevrev sift --input proposals.json --provider semif
```

The same provider flags work for `decide`. Credentials belong in
`JEVREV_JEV_API_KEY` or `TYPESAFE_API_KEY`, never in command arguments,
campaigns, evidence, or logs.

## Handoff format to the user

Keep the final message short and operational:

```text
JevSift kept: candidate-a, candidate-b
Probe status: candidate-a tests pass; candidate-b benchmark failed
Decide: winner candidate-a
Next action: review the evidence; nothing was merged
```

If setup is missing, say so. If Jev and a local judge disagree, report both
provider profiles and route the disagreement to review; do not hide it behind a
single score.

For a planning-only workflow, `jevrev run` remains available. Use it when the
host intentionally stops before probes.
