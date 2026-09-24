# Zero-context JevRev run

## What was tested

A new agent started from the repository README and treated JevRev as an
unknown tool. It built the CLI, inspected help, then used the full workflow on
a 25,000-event JSONL ingestion problem:

- 25,000 unique valid events;
- 184 malformed or schema-invalid lines;
- 258 repeated IDs;
- first-seen order must be preserved;
- malformed input must be isolated;
- duplicate IDs must be emitted once with the first payload.

The baseline parsed, deep-canonicalized, and hashed every event. The candidate
batch scanner parsed bounded slices and used an insertion-ordered set. A regex
shortcut was intentionally included because it was likely to look attractive
in a paper ranking.

## What JevRev did

Six proposals entered Sift. Two survived for a real probe: `batch-index` and
`regex-shortcut`. The batch candidate passed its differential correctness
check. The regex candidate returned exit code 1, reported 65 invalid records
instead of 184, and changed first-seen order. Evidence therefore rejected the
shortcut before semantic ranking could rescue it. Decide selected
`batch-index`.

Loop then ran three rounds against one artifact:

| Round | Outcome | Evidence |
| ---: | --- | --- |
| 1 | `fix_regression` | real correctness command failed |
| 2 | `verify` | fresh command, seven samples, artifact and protected-surface checks passed |
| 3 | `completed` | fresh completion evidence passed every criterion |

The final Loop state was `completed`, with head `demo-head-round3` and 838 ms
of recorded evidence wall time. The 1,628 provider tokens shown in the Loop
fixture are replay accounting, not hosted usage.

Long ingested 13 events, accepted an identical replay as 13 duplicates, and
accepted one verified Loop bridge event. Its observer surfaced a high
`failure_loop` alert and a critical `protocol` alert for an unsupported metric
event. It did not retry, edit, or steer the work.

## Measured comparison

The direct one-shot path immediately selected `regex-shortcut`; its correctness
oracle failed. The routed path selected `batch-index` and completed Loop.

| Measure | Direct one-shot | JevRev routed |
| --- | ---: | ---: |
| Candidate | `regex-shortcut` | `batch-index` |
| Correctness | 0/1 (0%) | 1/1 (100%) |
| Correctness exit | 1 | 0 |
| Mean throughput | 180,530.904518 events/s | 180,317.214988 events/s |
| Sample SD (`n-1`) | 8,567.371122 | 10,486.052789 |
| Semantic provider tokens | 0 (replay) | 0 (replay) |

The point of this run is not a synthetic speed claim. The direct shortcut was
slightly faster and wrong. The routed path spent effort on evidence and avoided
shipping it. The throughput and standard deviation are scoped measurements on
this deterministic corpus, not a production benchmark or a claim that the full
funnel is cheaper than one command.

## Friction found by the fresh user

1. No API key was available, so the agent had to use replay answers. This
   proves deterministic plumbing, not live Jev quality, latency, or price.
2. Loop and Decide replay answer keys were not obvious from the README. The
   agent had to inspect the emitted work order and correct the fixture shape.
3. An artifact can cite only the criterion it measures. A first attempt mixed
   correctness and runtime and was rejected by the protocol.
4. `long watch --interval-ms 1` failed because the actual minimum is 100 ms.
5. Long has no first-class metric event type yet, so the imported metric became
   a protocol alert.
6. Completion evidence IDs are digest-based and the fresh protected-surface
   claim is required, but that contract is not prominent in the quickstart.

These are recorded as product feedback, not hidden as successful commands.

## What this does not prove

It does not establish peak memory, sustained concurrent throughput, crash
recovery, hosted Jev behavior, provider billing, or performance outside this
corpus. The repository test suite at the time of the run reported 274 passing
tests; the current revision adds the Loop artifact-reference fix and is
validated separately before publishing.
