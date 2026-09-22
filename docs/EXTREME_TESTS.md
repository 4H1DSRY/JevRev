# JevRev adversarial acceptance tests

These tests are written from the user's point of view. They are not feature
checklists; each one tries to make JevRev produce a dangerous, misleading, or
useless answer.

## Layer map

| Layer | Current status | User-facing job | Must not do |
| --- | --- | --- | --- |
| JevRev | implemented umbrella | package, CLI, protocol, provider boundary | pretend one score proves a patch |
| JevSift | implemented inside JevRev | filter proposal cards and emit bounded probe work orders | claim a proposal works |
| Probe/Decide | implemented inside JevRev | validate recorded evidence, then choose a route | trust builder prose over facts |
| JevLoop | not implemented | audit each completed agent round and return the next action | become an uncontrolled infinite loop |
| JevLong | not implemented | monitor a long-running session for drift, stalls, tool failures, and budget risk | run as a hidden daemon or change code |

The current commands are intentionally namespaced under the `jevrev` binary:
`jevrev sift` is JevSift; `jevrev decide` is the evidence decision primitive.
JevLoop and JevLong must not be implied by those commands until their state
machines exist.

## Extreme cases

### Input and provider boundary

1. A request has 12 candidates, maximum-length fields, and all 66 duplicate
   pairs. Planning must finish, answer keys must remain unique, and JSON output
   must stay valid.
2. A request is exactly at the 32,000-character limit and one character over
   it. The first is accepted; the second fails before a provider call.
3. Candidate IDs differ only by case, Unicode normalization, or path-looking
   punctuation. Invalid IDs fail before a network call.
4. The provider returns a missing answer, an extra answer, the wrong typed
   answer, NaN/Infinity, an unknown score level, truncated JSON, HTTP 429, HTTP
   500, or a timeout. None may become a neutral score or a successful result.
5. A replay is reordered, has one finalist, contains duplicate candidate IDs,
   or is copied from another request. It must fail closed with a protocol error.
6. A live request has no credential. The error must name both supported
   environment variables and must never print a credential value.

### Evidence integrity

7. A packet marks a failed command as `required: false` and cites it from a
   passing requirement. It must still reject because cited mandatory evidence
   failed.
8. A packet has no commands at all but marks every requirement as pass. It must
   remain incomplete with `MISSING_REQUIRED_COMMAND`, never pass by vacuous
   truth or become a winner.
9. `development.wall_ms` is smaller than a recorded command duration. The
   packet is internally contradictory and must fail closed.
10. The campaign's probe budget, required evidence, stop conditions, or Sift
    result is edited without changing `campaign_id`. The campaign must be
    rejected as tampered.
11. An evidence packet uses another candidate hash, another campaign ID, a
    different base commit, an unknown metric reference, an unknown artifact,
    an absolute path, or `../../outside`. It must fail closed.
12. A passing metric cites a metric for a different criterion, or raw samples
    have fewer than two observations. It must fail before Decide.
13. A builder puts a persuasive success story in `builder_notes` while all
    objective evidence is missing. The result must be `probe_more`, not winner.

### Decision semantics

14. One finalist is eligible and another is low-confidence review. The result
    must be `human_review`; unresolved competition cannot be silently dropped.
15. All finalists fail hard gates. The result must be `no_winner`; the policy
    must not select the least-bad failure.
16. Two finalists pass and are objectively Pareto-dominated by one another in
    opposite dimensions. Jev may break a real trade-off, but must not call one
    dominated when it is not dominated.
17. Two finalists are close and complementary. The result must be `merge` with
    a combined probe, never an automatic merge.
18. Two finalists are close but non-complementary. The result must be
    `probe_more`, not a winner selected by a fourth decimal place.
19. Every finalist is incomplete. The result must request missing evidence and
    must not call Jev.
20. Decide output is manually mutated to say `winner` with a null winner, a
    merge candidate, or the wrong next action. The output schema must reject it.

### Workflow and UX

21. Human Sift output must show evidence IDs and descriptions, never
    `[object Object]`.
22. JSON mode must contain only JSON on stdout; progress and diagnostics belong
    on stderr.
23. The live provider disagrees with a captured local result. The provider
    profile and review state must make that disagreement visible.
24. A real long case has six or more candidates, hard constraints, competing
    budgets, and a tempting architecture rewrite. The selected work orders must
    be actionable rather than generic “build a prototype” prose.
25. A clean tarball install must expose `jevrev sift`, `jevrev decide`, the
    workflow fixture, the skill installer, and no local reports, credentials,
    or private planning notes.

## Current evidence

The repository currently covers these adversarial classes with automated tests:

- replay order and single-finalist replay;
- campaign and candidate hash tampering;
- failed/optional/cited commands and missing commands;
- wall-time contradictions;
- unknown metric and artifact references;
- path traversal and absolute paths;
- mixed eligible/review, no-winner, merge, probe-more, and human-review;
- objective dominance and contradictory Decide output;
- real ranking reversal with executed correctness and benchmark probes.

The remaining provider transport cases should be run against a mock HTTP server
before JevLoop is designed. A live API run is not a substitute for those fault
injection tests.
