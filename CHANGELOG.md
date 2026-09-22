# Changelog

## 0.2.0 — 2026-09-21

- Add `sift` campaigns with bounded probe work orders while preserving the
  original `run` and `rank` contracts.
- Add evidence packets with candidate hashes, command results, raw metric
  samples, requirement references, revision identity, budgets, and failures.
- Add `decide` with deterministic hard gates followed by a separate Jev
  evidence review.
- Support `winner`, `merge`, `probe_more`, `no_winner`, and `human_review`
  instead of forcing a winner.
- Add an executed ranking-reversal workflow demo and shared Decide support for
  Jev, SemIf, legacy local, and replay providers.
- Add `jevrev-evidence-template` so host agents can create a safe incomplete
  evidence handoff without manually reproducing the schema.

## 0.1.1 — 2026-09-21

- Reject replay fixtures whose `candidate_order` does not match the request;
  positional answers can no longer silently move to another candidate.
- Check hard-constraint risk before the confidence review route while keeping
  other low-confidence judgments reviewable.
- Add `next_action`, `empty_reason`, policy thresholds, and provider profile to
  the JSON handoff.
- Add a read-only case evaluator and an explicit bundled-skill installer.

## 0.1.0 — 2026-09-20

First JevRev release.

- `jevrev run` accepts structured candidate cards from a file or stdin.
- `jevrev rank` and the `specjev` binary remain compatibility aliases.
- Official Jev/TypeSafe, local SemIf, replay, and legacy reranker providers are
  available through one typed response contract.
- `--jev-url`, `--semif-url`, `--local-url`, `--output`, and `doctor` expose the
  integration surface needed by shell scripts and coding agents.
- Three realistic request scenarios, offline fixtures, module tests, and a
  at-least-five-repetition benchmark harness are included.
