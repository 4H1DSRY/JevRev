# JevLoop: one artifact, evidence-backed improvement rounds

Status: implementation contract. JevLoop is separate from JevSift and the
read-only JevLong observer. Probe, Evidence, and Decide are its shared working
infrastructure, not separate product components. JevLoop does not run an agent,
own a worktree, or merge code. A host agent calls it between bounded rounds.

## Fixed decisions

- One evolving artifact, one active round. No parallel candidate tree.
- No fixed number of rounds and no score-based premature success. Work can be
  paused for resource limits, lack of progress, or human input; only a full
  completion audit may return `completed`.
- A target, threshold, hard constraint, or rubric change creates a new approved
  spec revision. Previous audits remain attached to their old revision.
  `approved_by` is a recorded human attestation, not cryptographic identity;
  the CLI must require an explicit local human confirmation for both spec
  approval and resumption, and cannot prove that an agent with the same OS
  permissions did not impersonate the user.
- Progress audits focus on the current round and may carry unaffected evidence.
  Completion audits require *fresh* observations for **all** required criteria
  against the current revision and head. No carried evidence can complete.
- A mandatory hard command must be a successful `recorded` observation on the
  current head; an externally imported exit-code claim cannot complete it.
- One batched set of narrow Jev questions for the judged criteria in an audit.
  No default mesh, model-driven autonomous agent, TUI, or background daemon.
- `loop evidence-template` creates the Loop envelope. Existing Sift command,
  metric, and artifact recorders can supply facts for it, but do not write the
  Loop envelope directly. Imported or self-reported evidence is identified; it
  is not magically independently verified. Full completion may require human
  confirmation for subjective criteria or evidence that the recorder cannot
  authenticate.
- Judged artifact evaluations carry a required human-readable summary and may
  carry a bounded content excerpt. The digest binds the material; the summary
  and excerpt are what Jev can actually inspect.

## Modules and acceptance gates

1. **Contracts and state machine** (`src/loop/schemas.ts`, `state-machine.ts`):
   strict spec, orders, evidence and results; reject duplicate criterion IDs,
   unknown references, altered digests, invalid transitions and false
   completion. Unit tests cover each terminal and resumable state.
2. **Event store** (`store.ts`): append-only hash-chained events, atomic
   snapshots and exclusive mutation lock. Reads reconstruct state from the
   verified log without mutating the directory; the next mutation refreshes
   stale snapshots. Reopen validates sequence, chain, payload hashes and spec
   revisions. Provider/validation failures never
   advance state; simulated interruption and duplicate submission are tested.
3. **Work orders** (`planner.ts`): bound a single round goal, focus, scope,
   resources, required checks and stop conditions to immutable spec and base
   revision. Repeated `next` returns the same order without issuing a duplicate.
4. **Evidence audit** (`auditor.ts`): deterministic
   hard/metric/protected-surface checks before Jev; typed, narrow judgments for
   subjective criteria; explicit regression, plateau and budget routing.
   Completion requires fresh evidence on the current head. Tests include
   regression after apparent success, incomplete evidence, near-threshold
   scores, low confidence and provider failures.
5. **CLI/reporting**: `loop create`, `evidence-template`, `next`, `audit`,
   `status`, `resume`, `abort`, and human-approved `approve`. Machine output
   remains JSON-only on stdout;
   progress and errors go to stderr. Offline replay and mock providers exercise
   the complete loop end to end.

After each module a separate read-only agent audits its code, tests, and
contract. Findings must be fixed before the next module. A final independent
audit follows cross-module and clean-tarball checks.

## State semantics

```text
ready -> issued -> audited -> ready (continue / fix_regression / verify / replan)
                 -> waiting_human | budget_paused
                 -> completion_pending -> completed (completion audit only)
```

`waiting_human` and `budget_paused` are resumable; `completed` is not. `stop`
by the user is an explicit separate state. A plateau first yields `replan`;
another plateau without material progress yields `waiting_human`. Completion
never follows from reaching a total-score threshold or exhausting budget.

## Workflows to test on a real artifact

- A small website: desktop looks better, mobile regresses; next action must
  focus on mobile, and a carried desktop screenshot cannot close completion.
- A parser optimization: unit tests pass but measured throughput remains below
  target; continue rather than completed, then finish only after fresh samples.
- A failed command and a low-confidence subjective assessment: failed command
  blocks completion and low confidence requests evidence/human judgment.

Report actual elapsed time, judge usage, and measured criterion deltas. Claims
of saved time or tokens require a matched baseline; the demo alone is not that
baseline.
