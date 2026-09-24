# Real JSONL ingestion case

This is the recorded output of a zero-context user run through the JevRev
workflow. The agent started from the repository README and used the CLI to
run Sift, Evidence, Decide, Loop, and Long against one concrete engineering
problem.

The task was to process a JSONL event stream while preserving first-seen
order, isolating malformed records, and removing duplicate IDs. Six materially
different approaches were proposed. Sift kept two. The tempting regex shortcut
looked fast, but the real correctness probe rejected it. Evidence and Decide
selected the batch scanner; Loop then required a failing round to be repaired
and completed only after fresh evidence passed. Long observed the run and
verified the Loop bridge without taking control of it.

The full account is in [`ZERO_CONTEXT_DEMO.md`](ZERO_CONTEXT_DEMO.md). The
short machine-readable result is in [`RESULTS.json`](RESULTS.json), and the
recorded command sequence is in [`COMMAND_TRACE.md`](COMMAND_TRACE.md).

This is a deterministic local record. Jev answers were replayed because no
`JEVREV_JEV_API_KEY` was present. It demonstrates the workflow and its
evidence gates; it does not claim hosted Jev quality, provider latency, or
production throughput.
