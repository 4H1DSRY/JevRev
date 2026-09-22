# Case study: four real JevRev runs

This is the short version of the local evaluation notes used to harden the
release. The request files are not bundled because they belong to a separate
working directory; the evaluator accepts that directory directly.

## What was run

The case set contains four request files covering a tempting rewrite, multiple
hard constraints, CI time reduction, and a 12-candidate observability task.
The expected conclusions were written down before the runs.

| Provider | Cases | Result | Tokens (input + output) | Wall time |
| --- | ---: | ---: | ---: | ---: |
| Hosted Jev (`jev-1.13.0`) | 4 | 4/4 matched the predeclared conclusion | 29,886 + 4,372 = 34,258 | 4.67 s total |
| Local Qwen3.5-4B SemIf | 5 scenarios | 4/5 matched; one empty shortlist was a local calibration failure | about 151k | 16-78 s per run |

The hosted run selected the expected paths in all four cases. The local run was
still useful: it exposed that a single threshold profile cannot be assumed to
work for every judge model. The local observations remain a calibration set,
not a reason to claim that JevRev itself is wrong on the hosted path.

The numbers above are decision-routing measurements. They do not measure
production latency, defect rate, or engineering hours saved. The benchmark in
the README uses deterministic candidate-order rotations and reports the sample
standard deviation (`n - 1`) of the naive first choice versus the returned
shortlist. It measures order sensitivity, not general model uncertainty.

## Hosted/local fixture comparison

The supplied `local-setup` directory also contains captured hosted-Jev and
local-Qwen result files. Comparing those files offline avoids pretending that a
live API call happened when no credential or local server is configured:

| Case | Hosted selection | Local selection | Same selection? |
| --- | --- | --- | --- |
| shiny rewrite | `trim-and-split`, `assets-and-fonts` | `trim-and-split`, `assets-and-fonts` | yes |
| constraint traps | `streaming-pipeline` | `streaming-pipeline` | yes |
| duplicate and validation | `weighted-test-sharding`, `dependency-and-build-cache` | empty | no; local calibration failure |
| twelve candidates | `request-id-propagation`, `prometheus-metrics` | `request-id-propagation` | partial; local judge reviewed the second path |

The first two cases agree across providers. The latter two are useful failure
cases: a small local judge can be too conservative or uncertain even when the
hosted result is decisive. JevRev should surface that disagreement through
provider profiles and review, not hide it behind a shared score.

The live evaluator requires an explicit credential or a running local service.
With neither configured, it fails each case with a provider error and zero
tokens; that is an expected setup failure, not a quality measurement.

## Reproduce

Build the CLI, then point the read-only evaluator at the case directory:

```powershell
npm run build
$env:JEVREV_JEV_API_KEY = "..."
node scripts/eval-cases.mjs `
  --cases-dir C:\path\to\local-setup `
  --provider jev
Remove-Item Env:JEVREV_JEV_API_KEY
```

The evaluator prints selected IDs, review/reject counts, `next_action`, token
usage, and wall time. It does not write result files and never prints the key.

## Findings that changed the release

- Replay answers are positional, so fixtures now carry `candidate_order` and a
  mismatch is a protocol error instead of a silent reorder.
- Hard-constraint risk is checked before the confidence route. An uncertain
  hard violation is still rejected and carries both `CONSTRAINT_RISK` and
  `LOW_CONFIDENCE`; ordinary uncertainty remains reviewable.
- Empty results now explain the next move with `next_action` and
  `empty_reason`.
- Every result records the provider/model profile and the thresholds used for
  the decision.
