# JevRev 0.2.0 release sheet

Tagline: **Explore wide. Prove cheap. Commit once.**

Package: `jevrev@0.2.0`
Publish artifact: `jevrev-0.2.0.tgz`
Git tag: `v0.2.0`

Final package SHA-256 is recorded in the GitHub release metadata after the
tarball is generated; it is not self-embedded in the package.

## Publish sequence

```bash
npm ci
npm run check
npm test
npm run build
npm run demo:all
npm run demo:workflow
npm pack --dry-run
npm publish --access public
```

Repository: https://github.com/Alex314618-create/JevRev

The package metadata points at the public repository above. Do not publish a
live API key, local model, or `benchmarks/results/` output.

## Included

- compiled `jevrev` CLI and `specjev` compatibility binary;
- Jev/TypeSafe, SemIf, legacy local, and replay providers;
- request/response protocol and integration skill;
- three request examples and offline demo fixtures;
- local model lifecycle scripts and an at-least-five-repetition benchmark harness.
- read-only case evaluator (`scripts/eval-cases.mjs`) and explicit skill
  installer (`jevrev-skill-install`).
- Sift campaigns, bounded probe work orders, evidence packets, and evidence-backed
  Decide outcomes.
- UTF-8/UTF-16 JSON input, `evidence status --next`, and bounded `reconsider`
  promotion for Sift review candidates.
- JevLoop round protocol with `create`, `evidence-template`, `next`, `audit`,
  `status`, `resume`, `abort`, and human-approved `approve` commands.
- Hash-chained loop state, fresh completion proofs, metric aggregation,
  protected-surface checks, and explicit local/replay provider paths.
- JevLong read-only observer with JSONL `create`, `ingest`, `status`, and
  `watch` commands, deterministic snapshots, bounded event ingestion, and no
  hidden agent control.
- deterministic ranking-reversal workflow demo (`npm run demo:workflow`).

See [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) for the recorded checks and
known boundaries. The hosted/local case comparison is documented in
[`docs/CASE_STUDY.md`](docs/CASE_STUDY.md).
