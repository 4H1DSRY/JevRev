# Changelog

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
