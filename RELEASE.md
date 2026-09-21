# JevRev 0.1.0 release sheet

Tagline: **Spread wide. Keep what survives.**

Package: `jevrev@0.1.0`  
Publish artifact: `jevrev-0.1.0.tgz`  
Git tag: `v0.1.0`

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

See [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) for the recorded checks and
known boundaries.
