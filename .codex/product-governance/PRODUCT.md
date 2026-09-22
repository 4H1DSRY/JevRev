# JevRev Product Contract

Last reviewed: 2026-09-22

## Product Intent

JevRev is an evidence-backed speculative engineering funnel for coding agents. It helps an agent compare materially different implementation paths, spend engineering effort on a small probe set, and make the integration decision from recorded facts rather than proposal confidence alone.

## Audience And Primary Experience

- Primary audience: developers and maintainers directing coding agents on consequential engineering work.
- Primary need: avoid committing early to the first plausible mechanism when several alternatives deserve comparison.
- Primary experience: freeze one brief, sift candidate paths, execute bounded probes, capture evidence, and decide whether to integrate, combine, investigate further, stop, or ask a human.
- Intended outcome: a smaller implementation queue with an inspectable reason for every routing decision.

## Product Boundaries

### In Scope

- Structured candidate intake, Sift policy, and bounded work orders.
- Evidence envelopes, trusted command observations, measurements, and artifact references.
- Evidence-first Decide outcomes and provider/replay integrations.
- Agent-facing CLI, installable skill, examples, deterministic demonstrations, documentation, and npm packaging.
- A concise README flagship case that explains the complete current workflow with reproducible evidence.
- A compact, reproducible one-shot storefront comparison that makes design-direction routing visible without replacing the engineering evidence case.
- Tiered product positioning that distinguishes the shipped decision spine from JevLoop and JevLong roadmap layers.
- Clear first-run paths for an agent prompt, npm installation, hosted Jev, local SemIf, and agent-assisted configuration.

### Non-Goals

- Acting as a coding agent, automatically implementing every candidate, or merging branches.
- Claiming that shortlist selection proves correctness or production impact.
- Inventing engineering-time, token-saving, defect-rate, or business-impact measurements.
- Presenting a curated visual showcase as a neutral benchmark of all models, agents, prompts, or production websites.
- Building a web dashboard, daemon, persistent orchestrator, or automatic worktree system for the flagship case.

## System Map

- Candidate funnel: request schemas, typed questions, policy, Sift campaigns, and work orders.
- Evidence capture: templates, command recorder, metrics, hashes, references, and trust boundaries.
- Decision engine: deterministic gates, evidence review, five outcomes, and human-readable reports.
- Providers and protocol: hosted Jev, SemIf, legacy local, replay, CLI contracts, and diagnostics.
- Agent integration: installable skill and file-based handoff workflow.
- Experiments: deterministic demos, executed mini-projects, case fixtures, and benchmark records.
- Documentation and onboarding: README, workflow, protocol, acceptance evidence, and examples.
- Packaging and release: TypeScript build, tests, npm package contents, and release checks.
- Flagship communication: README case narrative and an accessible GitHub-native visual asset.

## Quality Bar

- Every prominent factual claim is traceable to a committed fixture, recorded release evidence, or a command run in the current workspace.
- Deterministic failures and hard constraints take precedence over judge scores.
- User-visible copy is concise, natural English and does not expose internal planning or prompt language.
- Product-layer copy clearly labels shipped and roadmap capabilities, and cost language includes its relevant boundary.
- The flagship visual works on GitHub light and dark backgrounds, has no external dependencies, and remains legible at narrow widths.
- Visual comparisons share a fixed content and behavior contract, record asset choices by direction, and state the limits of the comparison.
- Existing CLI contracts, packaging, and tests remain green after documentation or experiment changes.

## Definition Of Done

The flagship task is complete only when:

- At least one small end-to-end project has been executed locally through the evidence workflow and its output has been inspected.
- The README explains Sift, bounded probes, evidence, and Decide without overstating what was measured.
- The README leads from product value to verified proof to a low-friction setup path, while retaining stable product and protocol entry points.
- The flagship asset reflects verified case facts, includes accessible title and description text, and is visually checked in light, dark, desktop, and narrow contexts.
- The one-shot showcase pages and multi-image comparison are reproducible from committed local fixtures and do not displace the ranking-reversal proof.
- Relevant checks, tests, demos, build, and package dry run pass from the final upstream-synchronized branch.
- Governance evidence and the final diff agree with the repository.
