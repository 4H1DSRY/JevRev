# JevRev authority model

JevRev has four distinct authorities. Keeping them separate is part of the
product contract, not an implementation detail.

| Actor | Owns | Cannot do |
| --- | --- | --- |
| Human operator | Freeze or revise the contract, choose the provider, approve a resume, abort a loop, and decide whether a reported winner is integrated | Delegate trust to a model or treat an alert as an automatic command |
| Host agent | Propose candidates, execute bounded work orders, run commands through the recorder, and submit evidence | Change frozen policy, self-certify recorded evidence, merge a branch, or turn a review item into a winner |
| Jev / local judge | Supply narrow semantic judgements about proposals or evidence | Override schemas, budgets, command results, hashes, provenance, or state transitions |
| JevRev core | Validate contracts, hash identities, apply deterministic gates, maintain state, and emit typed next actions | Generate code, run an agent, edit files, create commits, merge branches, or silently continue in the background |

## Product component boundaries

- **JevSift** is stateless proposal pruning. It may issue bounded probe work
  orders, but it never executes them or selects an integration winner.
- **JevLoop** owns one evolving artifact and one active round. It issues a
  work order, receives the host agent's recorded evidence, and audits the round;
  the host agent remains responsible for the actual work. `resume`, `abort`, and
  spec revision approval are explicit human actions.
- **JevLong** is read-only observation. It ingests normalized events, derives
  snapshots, and raises alerts for a human. It does not start, stop, retry,
  steer, edit, or kill the observed agent.

`Probe`, `Evidence`, and `Decide` are shared infrastructure beneath JevSift and
JevLoop. Probe is the bounded work the host agent executes; Evidence is the
recording and validation protocol; Decide is the typed adjudication primitive
used by Sift and by Loop's round audit. They are not additional product
components or authorities.

The evidence recorder is a host-agent tool, not an authority. It can execute
the exact argv supplied by its caller inside the declared workspace boundary
and record the result; it cannot mark an observation successful, promote
provenance, or integrate a candidate. Child output is quiet by default and
`--echo` is an explicit operator choice.

## Trust order

When signals disagree, use this order:

1. Schema, identity, hash, budget, and state-machine checks.
2. Recorded command results, required tests, protected-surface checks, and
   raw measurements.
3. Imported or self-reported evidence, clearly marked as weaker provenance.
4. Jev's narrow semantic judgement.
5. Human judgement for policy changes, subjective trade-offs, and integration.

No component is allowed to silently promote a lower-trust claim into a
higher-trust fact.
