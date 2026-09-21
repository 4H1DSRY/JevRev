---
name: jevrev
description: Explore competing implementation mechanisms, probe the finalists, and choose from recorded evidence before committing to a path.
---

# JevRev

Use JevRev when several materially different mechanisms could solve a task and
choosing the wrong one would cost more than two bounded probes. Do not use it
for an obvious one-line fix or a cheap reversible choice.

JevRev does not edit or merge a repository. The host agent owns code and tools;
JevRev owns the frozen brief, Sift, evidence contract, and Decide policy.

## Workflow

1. Freeze the goal, hard/soft constraints, falsifiable success criteria, and
   implementation budget before developing any candidate.
2. Generate 4-7 genuinely different mechanism cards. Each needs `id`, `title`,
   `summary`, `mechanism`, `assumptions`, `risks`, `validation`, and `effort`.
3. Run:

```bash
jevrev sift --input proposals.json --format json > campaign.json
```

4. Read `work_orders`. In separate branches or worktrees, perform only the
   smallest reversible probe requested for each survivor. Respect its wall-time,
   changed-file budget, and stop conditions. Do not turn every branch into a
   complete product.
5. Record raw evidence in a `jevrev.evidence-bundle`:
   - revision identity;
   - command argv, exit code, duration, and output digests;
   - raw baseline and candidate samples;
   - results for every success criterion and hard constraint;
   - changed files, time/cost, and known failures.
6. Run:

```bash
jevrev decide \
  --campaign campaign.json \
  --evidence evidence.json \
  --format json > decision.json
```

7. Follow the typed outcome:
   - `winner` / `integrate_winner`: show the user the evidence and ask before
     applying or merging;
   - `merge` / `probe_combination`: run a combined probe; do not merge the two
     branches yet;
   - `probe_more` / `collect_evidence`: collect only the missing or
     discriminating evidence;
   - `no_winner` / `revise_ideas`: discard the failed paths and generate a new
     mechanism set;
   - `human_review` / `ask_human`: present the unresolved trade-off.

## Evidence rules

- A model judgment never overrides a failed required command or hard
  constraint.
- `builder_notes` are untrusted context and cannot satisfy a requirement.
- Passing requirements must cite an observation or metric.
- Supply raw samples; JevRev recomputes means, sample standard deviations, and
  relative improvement.
- Do not reuse evidence across a different candidate or campaign. Hash
  mismatches are protocol errors.
- Treat `merge` as a request for a combined experiment, not a shipping decision.
- Stop before merge unless the user explicitly authorizes it.

## Provider options

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
`JEVREV_JEV_API_KEY` or `TYPESAFE_API_KEY`, never in a command argument or an
evidence packet.

For a one-pass shortlist without probes, `jevrev run` remains available. Use it
only when the host workflow intentionally stops at planning.
