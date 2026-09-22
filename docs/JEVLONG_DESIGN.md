# JevLong: long-running session observer

Status: design baseline. This document defines the first implementable JevLong
slice. It does not change JevLoop and it does not authorize a background agent
runner.

## 1. Boundary

JevLoop audits one completed round and returns a typed next action. JevLong
observes an entire session while it is running and reports risk to a human.

```text
JevLoop:  round evidence -> audit -> continue / fix / verify / completed
JevLong:  event stream   -> snapshot + alerts
```

JevLong must not:

- start, stop, retry, or steer an agent;
- edit files, create commits, merge branches, or kill processes;
- claim that a goal is complete from activity alone;
- turn an uncalibrated model score into a probability;
- silently upload raw transcripts, source files, secrets, or environment data.

The human remains the operator. A Long alert is a request for attention, not a
command to the agent.

## 2. Product shape

The MVP is a local JSONL observer with a small CLI surface:

```text
jevrev long create   --directory .jevrev/long --spec long-spec.json
jevrev long ingest   --directory .jevrev/long --input events.jsonl
jevrev long status   --directory .jevrev/long --format human
jevrev long watch    --directory .jevrev/long --interval-ms 1000
```

`ingest` accepts normalized events. Adapters for Codex, Claude Code, CI, or a
custom harness convert their native logs into that contract. The observer is
also usable as a pipe:

```text
agent/harness -> JSONL stdout or file -> JevLong -> human stderr / JSON report
```

There is no daemon requirement in the first release. A host may call `ingest`
after every event, after a bounded batch, or at a heartbeat interval. A future
TUI can read the same snapshot and alert files without changing the reducer.
Without a host heartbeat or an explicit `watch`, a silent process cannot
produce a new alert by itself; this is an explicit limitation, not hidden
background behavior.

### MVP hard limits

The first implementation must make its cost envelope explicit:

```text
max_event_bytes: 64 KiB
max_batch_events: 256
max_batch_bytes: 1 MiB
max_open_tool_calls: 512
max_recent_events: 2,048
max_open_alerts: 64
max_alert_history: 10,000
max_session_bytes: 256 MiB before segment rotation
```

One batch gets one journal append, one reducer pass, and one snapshot checkpoint.
Normal status reads only the verified snapshot. Startup/recovery may validate
the journal tail; it must not replay the complete history on every ingest.
Long sessions use immutable 64 MiB/100k-event segments plus a compacted
checkpoint. Reports default to summaries and require an explicit history limit.

## 3. Frozen session specification

`LongSpec` is created once and is immutable until a human-approved revision.
It should contain:

```text
kind: jevrev.long-spec
schema_version: 1
revision: positive integer
session_id: jvlng_<16 lowercase hex>
title, goal, context?
workspace: relative path
allowed_scope: relative paths/globs
protected_surfaces: stable IDs and descriptions
milestones: ordered IDs, descriptions, optional evidence tags
budget:
  max_wall_ms
  max_provider_tokens
  max_tool_calls
thresholds:
  stall_after_ms
  heartbeat_after_ms
  repeated_failure_window
  repeated_failure_count
  drift_warning_score
  budget_warning_fraction
alert_policy:
  cooldown_ms
  max_open_alerts
  severity_escalation_window
observer_budget:
  provider: none | jev | local
  max_calls
  max_tokens
  max_wall_ms
  timeout_ms
  min_interval_ms
  max_context_bytes
```

Do not require milestones for observation, but make the progress indicator
`unknown` when no milestones or objective evidence have been declared. A busy
session is not necessarily a progressing session.

## 4. Event contract

Every event is append-only and has a sequence number, timestamp, source, and
payload digest. The payload is intentionally normalized rather than a raw
transcript.

Required common fields:

```text
kind: jevrev.long-event
schema_version: 1
session_id
sequence
occurred_at (UTC)
received_at (UTC, written by the local observer)
event_id (stable observer event ID)
adapter_id (bounded namespace)
adapter_event_id (stable producer ID; namespaced by adapter_id)
spec_revision
spec_sha256
source: recorded | imported | self_reported
event_type
payload_sha256
```

`sequence` is assigned by the Long journal, never copied from an adapter.
`adapter_id + adapter_event_id` is the idempotency key. Re-ingesting the same
key and identical redacted payload is a no-op; the same key with a different
payload is a protocol error. Concurrent distinct events receive one serialized
journal order. A batch is atomic: one malformed event rejects the entire batch
and cannot change the snapshot.

The observer writes `received_at` and an evaluation clock. Signals use that
trusted local time, not an unbounded producer timestamp. Producer time may be
kept for display, but future timestamps beyond the configured skew or severe
clock rollback are rejected/downgraded. Replay accepts an explicit fixed
evaluation time so the same journal produces the same snapshot.

Every event is bound to the active `spec_revision` and `spec_sha256`. Scope,
threshold, budget, and protected-surface changes require a human-approved spec
revision event. Hash chaining provides integrity, not writer authentication.

Initial event types:

| Event | Minimum payload | Meaning |
| --- | --- | --- |
| `session_started` | base_revision, host, adapter | Session became observable |
| `heartbeat` | adapter_seq | Producer is alive; no progress implied |
| `assistant_turn` | turn_id, text_digest, token counts | Agent emitted a turn summary; raw text is optional and off by default |
| `tool_started` | call_id, tool, argv_digest, cwd | Tool call began |
| `tool_finished` | call_id, exit/termination, duration, output digests | Tool call ended |
| `file_change` | path, operation, revision | A file was changed; content is not embedded |
| `test_result` | command_id, status, count, revision | Objective test signal |
| `milestone` | milestone_id, status, evidence_refs | Host declares a milestone observation |
| `provider_error` | provider, category, retryable, message_digest | Provider/API failure |
| `human_input` | input_digest, actor | Human intervened |
| `session_finished` | status, reason, final_revision | Producer says the session ended |

Unknown event types are stored as `unknown_event` and raise a protocol alert;
they must not be treated as progress.

Unknown payloads are bounded opaque digests, not arbitrary raw JSON. They cannot
carry milestone, test, or progress fields. The normalized CLI never accepts
raw transcripts or caller-selected `source: recorded`; external JSONL is forced
to `imported` or `self_reported`. `recorded` is reserved for a controlled local
recorder API (later it may carry an attestation). A self-reported or imported
test/milestone can be shown, but can never become trusted progress evidence.

### Authenticity

`source` is part of every observation. A self-reported `test_result` may inform
the dashboard but cannot prove a milestone. A future trusted recorder can emit
`recorded`; imported logs remain visibly weaker. This follows the existing
Evidence and JevLoop rule that provenance matters.

### Redaction

Adapters must hash or redact:

- API keys, bearer tokens, cookies, private keys, and environment values;
- raw source and complete tool output unless explicitly requested;
- full prompts and transcripts by default.

The event schema should accept bounded `message_digest`, `stdout_sha256`, and
`stderr_sha256`, not arbitrary unbounded strings.

## 5. Modules

### Module A: contracts (`src/long/schemas.ts`)

Own `LongSpec`, `LongEvent`, `LongAlert`, `LongSnapshot`, report schemas, IDs,
path bounds, threshold constraints, and revision rules.

Acceptance gate:

- every ID and reference is bounded and unique;
- workspace paths reject absolute paths and `..` traversal;
- budgets and thresholds have sane ordering;
- unknown event types parse into a safe envelope, never into a trusted fact;
- completion is not a valid Long status.

### Module B: normalization and redaction (`src/long/normalize.ts`)

Convert adapter payloads into the event contract. This is the only module that
knows native adapter shapes. It performs secret redaction, size limits, path
normalization, and source labeling.

Acceptance gate:

- the same native event produces deterministic normalized JSON;
- secrets are removed before hashing or persistence;
- malformed native input becomes an explicit protocol alert;
- no shell command is executed by normalization.

### Module C: append-only event store (`src/long/store.ts`)

Persist `events.jsonl`, `snapshot.json`, and an immutable identity file. Use the
same hash-chain and exclusive mutation approach as JevLoop, but keep Long's
event vocabulary separate. Reads reconstruct from the verified chain and never
mutate the directory.

Acceptance gate:

- duplicate sequence, reordered event, changed payload, truncated line, and
  wrong session ID are rejected;
- concurrent ingest cannot duplicate or reorder events;
- snapshot loss is recoverable from the event chain;
- a durable event append is not reported as failed only because snapshot cache
  refresh failed.

### Module D: deterministic signal reducers (`src/long/signals.ts`)

Compute indicators from the event window and frozen spec. Indicators are not
claims; each one carries evidence references and a freshness marker.

Initial indicators:

| Indicator | Deterministic inputs | Output |
| --- | --- | --- |
| `activity` | last event, open tool calls, heartbeat age | active / quiet / silent |
| `stall_score` | time since meaningful event, repeated no-op turns, open call duration | `[0,1]` score |
| `failure_score` | failed tool/test calls, repeated error fingerprints, provider errors | `[0,1]` score |
| `drift_score` | changed paths outside allowed scope, protected-surface edits, goal/milestone mismatch | `[0,1]` score |
| `budget_risk` | elapsed/time budget, provider tokens, tool calls, recent burn rate | `[0,1]` score |
| `progress_index` | recorded milestones and objective test events | `[0,1]` or `unknown` |

The UI may show “risk score”. It may show “probability” only when a calibration
version and reference dataset are declared. A raw Jev confidence is not a
calibrated probability.

### Module E: optional Jev observer (`src/long/judge.ts`)

Jev is a post-MVP optional observer, called only for a bounded anomaly batch,
never for every event. The default path is deterministic and zero-cost. A batch
may ask narrow questions:

- Is the current summarized trajectory plausibly aligned with the goal?
- Is this repeated failure materially different from the prior failures?
- Does the supplied evidence indicate a human should inspect the session?

The judge receives digests, counters, paths, milestones, and recent normalized
events, not secrets or full transcripts. Jev may raise confidence or request
human attention; it cannot clear a deterministic hard failure or close a Long
session.

If enabled, `observer_budget` must freeze `provider`, `max_calls`,
`max_tokens`, `max_wall_ms`, `timeout_ms`, `min_interval_ms`, and
`max_context_bytes`. Default provider is `none` and max calls is zero. Jev runs
after the deterministic append, outside the mutation lock; timeout, malformed
output, outage, or budget exhaustion falls back to the deterministic snapshot.

### Module F: alert policy (`src/long/policy.ts`)

Turn indicators into debounced alerts. Alerts are append-only decisions with
severity, kind, reason codes, evidence references, confidence, and a human
recommendation.

Initial alert kinds:

- `stall`: meaningful progress has stopped beyond the configured window;
- `silent`: heartbeat or producer activity is absent beyond the threshold;
- `failure_loop`: the same tool/command failure repeats;
- `drift`: files or actions leave the declared scope;
- `protected_surface`: a protected path changed;
- `fatal_error`: unrecoverable provider/process/protocol error;
- `budget_risk`: projected wall time/tokens/tool calls exceed the warning level;
- `human_attention`: deterministic signals and optional Jev both indicate review.

Policy uses hysteresis and cooldown. An alert is closed only by a later event
that proves recovery or by explicit human acknowledgement. Repeated identical
alerts must update a counter, not flood the terminal.

Alert lifecycle is explicit and replayable:

```text
open -> acknowledged -> recovered -> closed
                 \-> open (condition still present)
```

`acknowledged` means seen by a human; it does not hide an unresolved alert.
`recovered` requires a matching recovery signal. `alert_raised`,
`alert_acknowledged`, `alert_recovered`, and `alert_closed` are journal events,
not snapshot-only fields. A heartbeat can recover `silent`; it cannot by itself
recover `stall` or `failure_loop`.

### Module G: snapshot and dashboard (`src/long/store.ts`, `src/long/tui.ts`)

Build a stable `LongSnapshot` after each accepted event:

```text
session_id, sequence, lifecycle: created | observing | ended | aborted
last_event_at, open_tool_calls
indicators: activity, stall, failure, drift, budget, progress
open_alerts, acknowledged_alerts
milestones: pending | active | passed | failed
cost: wall_ms, provider_tokens, tool_calls
```

Human output is concise and actionable. JSON output is the machine contract.
Neither output implies that an agent should be automatically driven.

### Module H: CLI and adapters (`src/long/commands.ts`, `src/cli.ts`)

The first adapter is JSONL/stdin/file. Later adapters can be added without
changing the reducer. The current commands are:

```text
long create     freeze a LongSpec
long ingest     normalize and append one bounded event batch
long status     print the current snapshot
long watch      render the external dashboard without driving the agent
```

The following are planned extensions, not commands in the current release:

```text
long report       emit event/indicator/alert history
long acknowledge  mark an alert as human-seen
long close        explicitly end or abort the observation
```

`long ingest` must be idempotent for an adapter event ID. It must never execute
the command represented by an event.

The MVP implementation order is A-D, F-G, then H. Module E (Jev observer) and
the Loop bridge come only after the deterministic path has passed performance,
security, and replay tests. This is what keeps ordinary healthy events local,
cheap, and timely.

## 6. Loop bridge

Long may observe Loop, but the ownership remains separate. A Loop bridge event
can include:

```text
loop_id, round_number, work_order_sha256, audit_outcome, evidence_sha256
```

Long can display “round 3 audited: fix_regression” and raise a stall or budget
alert. It must not call `loop next`, mutate Loop state, or reinterpret a Loop
audit as session completion. JevLoop remains the source of truth for round
semantics.

## 7. State and alert semantics

Lifecycle is intentionally small:

```text
created -> observing -> ended
                    -> aborted
```

Risk is orthogonal and represented by open alerts. Do not encode every risk as a
new lifecycle state; simultaneous `budget_risk` and `drift` are normal. An
`ended` session can still have unresolved alerts, which the report must show.

## 8. Implementation order and acceptance gates

1. Contracts and fixtures.
2. Normalizer/redactor with secret and path tests.
3. Hash-chained store with crash/concurrency tests.
4. Deterministic signal reducers.
5. Alert policy with cooldown/hysteresis and persisted alert events.
6. Snapshot/report rendering.
7. CLI JSONL adapter and end-to-end fixtures.
8. Performance/retention gate for 100k+ events.
9. Optional Jev observer and Loop bridge.

Each module must pass its own tests before the next module starts. The final
gate runs the full suite, a clean package build, and long-session scenarios
without an API key.

## 9. Test matrix

### Contract and security

- absolute, drive-relative, and traversal paths are rejected;
- oversized event payloads and unbounded transcript fields are rejected;
- secret patterns are redacted before persistence and digesting;
- duplicate IDs, wrong session IDs, wrong revisions, and unknown references
  fail closed;
- an imported/self-reported pass cannot be upgraded to recorded evidence.
- a forged `recorded` source from JSONL is rejected or downgraded;
- duplicate adapter IDs are idempotent only for identical payloads;
- every event is bound to the active spec hash/revision and trusted receive time;
- raw secrets never appear in normalized payloads, hashes, snapshots, alerts,
  reports, diagnostics, or Jev prompts.

### Store and concurrency

- sequence gaps, reorder, tampered payload, bad previous hash, truncated JSONL;
- two concurrent ingesters for the same adapter event ID;
- stale lock, live lock, malformed lock, dead-process recovery;
- missing/corrupt snapshot reconstruction;
- append succeeds even when cache refresh fails.
- valid-before-invalid batches are atomic and leave the prior snapshot intact;
- canonical JSON key ordering makes hashes stable across equivalent inputs;
- one bounded batch performs one durable append/checkpoint, not one per event.

### Signals

- heartbeat without progress is not progress;
- a long-running tool call is active, not stalled, until its timeout threshold;
- repeated identical failures raise `failure_loop` once and then debounce;
- a failed attempt followed by a passing test lowers failure risk;
- out-of-scope and protected-path changes raise drift regardless of prose;
- no milestones means progress is `unknown`, not zero and not complete;
- budget risk includes both prior burn and projected recent burn rate.
- open calls, event windows, fingerprints, and alerts have bounded cardinality;
- replay with a fixed evaluation clock is deterministic;
- a future or rolled-back producer clock cannot manufacture progress or silence.

### Policy and UX

- cooldown prevents alert floods;
- recovery closes only the matching alert;
- acknowledgement does not erase evidence or hide an unresolved condition;
- JSON stdout contains only protocol output; diagnostics go to stderr;
- invalid format/output/provider options do not mutate the event store;
- close is explicit and cannot be triggered by an assistant message;
- provider outage falls back to deterministic indicators and records the outage.
- acknowledgement is distinct from recovery and does not hide open risk;
- `close` is explicit human input; self-reported `session_finished` cannot end a
  session or admit post-close mutations.

### End-to-end scenarios

1. **Healthy coding session:** start, edit in scope, tests pass, milestone passes;
   no alerts, progress becomes measurable.
2. **Silent hang:** tool call remains open and heartbeats stop; one `silent`
   alert appears, then closes after a new heartbeat.
3. **Failure loop:** the same test command fails four times; one escalated
   `failure_loop` alert appears with all four event references.
4. **Drift:** agent edits a protected file and continues; `protected_surface` is
   emitted even if the agent claims success.
5. **Budget spiral:** token burn rate projects overrun; `budget_risk` appears
   before the hard cap and remains visible after session close.
6. **Protocol corruption:** malformed tool event and assistant-visible tool-call
   text; `fatal_error`/`protocol` alert is raised without attempting recovery.
7. **Loop bridge:** Loop returns `fix_regression`; Long displays it and observes
   subsequent work, but never issues the next round.

8. **Cost gate:** 100k healthy heartbeat/tool events produce zero Jev calls,
   stay within the event/window caps, and keep status reads snapshot-only. A
   repeated failure storm produces one debounced Jev opportunity at most within
   the configured cooldown and never blocks deterministic ingest.

## 10. Non-goals for the first Long release

- no autonomous retry, kill, patch, or prompt injection;
- no always-on cloud service;
- no transcript warehouse;
- no mesh of Jev judges;
- no claim that a risk score predicts success without calibration;
- no replacement for Loop completion evidence or the human operator.
