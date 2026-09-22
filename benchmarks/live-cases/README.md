# Live case fixtures

These requests are deliberately longer than the offline demos. They represent
the kind of decision where a wrong implementation path is expensive:

- `tenant-auth-migration.json` — multi-tenant credential migration with a
  compatibility window and hard isolation requirements;
- `checkout-performance.json` — mobile LCP work with URL, interaction, and
  two-week delivery constraints;
- `pipeline-idempotency.json` — at-least-once payment ingestion with state and
  notification correctness requirements.

They contain no credentials and are safe to commit. A live run requires the
caller to set `JEVREV_JEV_API_KEY` in the environment:

```powershell
$env:JEVREV_JEV_API_KEY = "..."
jevrev run --input benchmarks/live-cases/tenant-auth-migration.json --provider jev --format json
Remove-Item Env:JEVREV_JEV_API_KEY
```

The generated results belong under the ignored `benchmarks/results/` directory;
they are not part of the source fixture or package.
