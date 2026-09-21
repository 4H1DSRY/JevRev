# JevRev Test Plan

Tests are organized by ownership boundary. Wording snapshots are deliberately
avoided; tests assert observable contracts and decision invariants.

## Domain schema

- Accept the smallest valid request.
- Accept the parser demonstration request.
- Reject unknown protocol versions.
- Reject fewer than two or more than twelve candidates.
- Reject duplicate candidate IDs.
- Reject unsafe/ambiguous IDs.
- Reject empty mechanisms and validation plans.
- Reject `max_survivors` larger than the candidate count.
- Reject overlong state fields before a provider call.

## Question builder

- Emit exactly five per-candidate questions plus every unique candidate pair.
- Put goal, constraints, success criteria, and candidate cards in state.
- Explicitly name `candidates[index]` in every per-candidate instruction.
- Explicitly name both indexes in duplicate questions.
- Use stable answer keys independent of candidate titles.
- Omit no-hard-constraint ambiguity by treating an empty set explicitly.

## TypeSafe adapter

- Pass the selected model, state, and full question batch to the official SDK.
- Normalize Noul and Score answers without rounding away probabilities.
- Preserve model name and token usage.
- Reject missing, extra-type, or malformed answers.
- Map authentication, timeout, and rate-limit errors to provider errors.

## Ranking policy

- Keep the highest eligible candidate within budget.
- Hard-reject a candidate below the constraint threshold regardless of its
  composite score.
- Hard-reject clear goal mismatch and infeasibility.
- Route low-confidence candidates to review rather than rejection.
- Apply the documented effort multiplier exactly once.
- Reject a lower-scored near-duplicate of an already-kept candidate.
- Do not treat two dissimilar candidates as duplicates.
- Apply budget cutoff after hard gates and deduplication.
- Produce deterministic ordering for equal scores using candidate input order.
- Return a valid empty selection when all candidates fail.

## Reporting

- JSON output validates against the result schema.
- JSON mode writes no banners or progress text to stdout.
- Human output lists survivors first and exposes signal values and reason codes.
- Human output never presents generated prose as a Jev explanation.

## CLI integration

- Read a request from a file.
- Read a request from stdin.
- Run from a captured replay without `TYPESAFE_API_KEY`.
- Fail helpfully when a live run lacks an API key.
- Honor `--top` without mutating the input file.
- Return documented exit codes for invalid input and malformed replay.

## End-to-end demonstration

Given the parser fixture with seven candidates and the captured Jev response:

- Reject the native rewrite for constraint risk.
- Reject parallel parsing for low feasibility.
- Deduplicate the second allocation-focused approach.
- Keep no more than two candidates.
- Emit the same selected IDs in human and JSON modes.
