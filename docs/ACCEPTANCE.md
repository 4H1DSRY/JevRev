# JevRev release acceptance

Release candidate: `0.1.0`  
Product: JevRev  
Tagline: **Spread wide. Keep what survives.**

The checks below are the acceptance record for this package. Commands were run
from the repository root on Node.js 25.2.1 / Windows PowerShell; the package
requires Node.js 20 or newer.

## Module checklist

| Module | Acceptance check | Result |
| --- | --- | --- |
| Request schema | 2–12 candidates, bounded fields, unique IDs, hard/soft constraints, budget validation | PASS |
| Question planner | Five typed candidate questions plus pairwise duplicate questions; canonical live ordering | PASS |
| Jev adapter | Official SDK, explicit `--jev-url`, model selection, API-key environment aliases, typed response validation | PASS |
| SemIf adapter | Local Qwen3.5-4B option-logit protocol at `/v1/chat/completions`; no prose parsing | PASS |
| Legacy local adapter | Reranker protocol at `/v1/score` retained as an explicit compatibility provider | PASS |
| Policy | Hard gates, confidence review route, effort weighting, deduplication, survivor budget | PASS |
| Handoff | JSON `selected`, `shortlist`, decisions, reason codes, usage, stable run IDs | PASS |
| CLI | `run`, `rank` compatibility alias, stdin, file input, `--output`, stable exit codes | PASS |
| Operations | `doctor`, local health probes, PowerShell model lifecycle scripts | PASS |
| Documentation | README, protocol, design, local setup, skill, release notes | PASS |
| Packaging | `npm pack --dry-run`, compiled CLI, examples, docs, scripts, no generated benchmark results | PASS |

## Automated tests

```text
npm run check     PASS
npm test          PASS — 52 tests
npm run build     PASS
```

The tests cover schema rejection, question construction, official-client
transport, local response mapping, SemIf option-logit normalization, policy
invariants, JSON/human reporting, stdin, output files, provider errors, and
the public input-address diagnostic.

The legacy Python reranker runtime suite also passes:

```text
python -m unittest discover -s runtime/tests -v  PASS — 7 tests
```

## Offline demonstrations

```text
npm run demo      PASS — parser-speedup fixture
npm run demo:all  PASS — parser-speedup, api-boundary-hardening,
                       flaky-ci-concurrency
```

Offline fixtures prove deterministic protocol and policy behavior. They are
not presented as live model measurements.

## Local model run

The pinned local service was started with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
powershell -ExecutionPolicy Bypass -File scripts/status-semif.ps1
```

Health returned `200 OK` on `http://127.0.0.1:4878/health`. The parser live
run and the three-scenario benchmark completed through the real local Qwen
model, not a replay fixture.

## Candidate-coverage decision benchmark

The benchmark rotates candidate order so every candidate is first at least once
(at least five runs per scenario; the recorded run uses 7/6/6 repetitions for
the 7/6/6-candidate scenarios). Quality labels are declared in the benchmark
manifest before execution as a human-authored scenario rubric, not external
ground truth. “Shortlist best utility” means the best utility among strict
`selected` candidates plus any budget-filling `review` candidate; mean utility,
precision, recall, and strict selected quality are reported separately. A zero
order-rotation standard deviation means the fixed local run was unchanged
under these rotations; it is not a general model-stability estimate.

| Scenario | First idea (mean ± order σ) | Shortlist best / mean / P / R | Strict selected best / mean / P / R | E2E CLI time | Provider tokens (in/out; Δ vs first idea) | Estimated token spend | Slots saved vs trying all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Parser speedup | 0.550 ± 0.382 | 1.000 / 0.975 / 1.000 / 1.000 | 1.000 / 0.975 / 1.000 / 1.000 | 10,234 ms ± 189 | 27,488 / 56; +27,544 | $0.00 local | 5 |
| API boundary hardening | 0.412 ± 0.385 | 1.000 / 0.850 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 / 0.500 | 8,005 ms ± 35 | 21,430 / 45; +21,475 | $0.00 local | 4 |
| Flaky CI concurrency | 0.433 ± 0.448 | 1.000 / 0.975 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 / 0.500 | 8,148 ms ± 22 | 21,539 / 45; +21,584 | $0.00 local | 4 |

Local API spend is zero because the judge ran on loopback; hardware and
electricity are excluded. The benchmark records token counts and accepts
`JEVREV_INPUT_USD_PER_MILLION` / `JEVREV_OUTPUT_USD_PER_MILLION` for a hosted
illustrative estimate. These rates are not official Jev billing; no provider
price is invented in the release report.

The first-idea baseline is intentionally a quality baseline, not a cost claim:
it spends no judge tokens but is order-sensitive. The token deltas above are
therefore the full JevRev decision overhead for this run. JevRev adds measured
judge time and tokens to reduce decision variance before downstream
implementation; whether that trade is favorable depends on the cost of a
wrong implementation in the host workflow.
The “slots saved” column is a candidate-card count relative to trying every
card, not a measured engineering-token or wall-clock saving.

Raw observations and per-scenario JSON summaries are generated under
`benchmarks/results/`; they are excluded from the npm tarball.

The recorded run is `bench_muagsjry_b903c3c2` with CLI artifact SHA-256
`5853d720bb356e446af8383e51966d6e151532c789e1f491b557761a9febbce5`.

## Known boundaries

- A `selected` candidate is a routing decision, not proof of correctness.
- `review` candidates remain unresolved; `shortlist` makes them visible to the
  host agent without silently approving them.
- The benchmark evaluates decision quality against declared scenario labels;
  it does not claim that JevRev alone improves production latency or defect
  rate.
- The public repository is
  `https://github.com/Alex314618-create/JevRev`. The publish tag for this
  release is `v0.1.0`; create it when the release commit is pushed.
