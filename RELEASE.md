# JevRev 0.1.1 release sheet

Tagline: **Pick the right path before you build.**

Package: `jevrev@0.1.1`
Publish artifact: `jevrev-0.1.1.tgz`
Git tag: `v0.1.1`

Final package SHA-256: `E8389CF9D6635973A59ECDF48AA353CEBFF47534E3E0F188F9BF8BA8677AEA10`

## Publish sequence

```bash
npm ci
npm run check
npm test
npm run build
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

See [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) for the recorded checks and
known boundaries. The hosted/local case comparison is documented in
[`docs/CASE_STUDY.md`](docs/CASE_STUDY.md).
