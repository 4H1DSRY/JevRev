# One-shot landing-page showcase

This fixture evolves two real landing pages from the same frozen JevRev content
and behavior contract:

- `direct/` commits to the first conventional direction, preserves its rounded
  SaaS grammar, omits imagery, and limits the changed light source to a
  restrained purple-black transition;
- `routed/` compares four materially different directions through JevRev Sift,
  then lets the selected mechanism determine information architecture,
  interaction, typography, color, and motion.

The routed condition selected `painterly-evidence-dossier` with a policy score
of `0.9149`. Its negative skull is a transparent derivative of the existing
banner, so the line work shares the page surface instead of sitting inside a
separate image background.

The controls shared by both conditions are task, audience, required sections,
copy, behaviors, dependency budget, theme support, responsiveness, and
accessibility requirements. Asset use is a direction-level choice: the direct
page omits imagery, while the routed page preserves the available skull anchor.

This is a controlled showcase, not a neutral benchmark of every model, agent,
or production workflow. It demonstrates that a bounded direction
selection can produce a visibly different committed artifact under these
recorded inputs. It does not measure cost, generation time, business lift, or
universal design quality.

## Reproduce

Build JevRev, rerun Sift through the deterministic replay, and validate both
pages:

```bash
npm run build
npm run demo:oneshot
```

Preview the pages:

```bash
node scripts/serve-one-shot-showcase.mjs
```

Then open:

- `http://127.0.0.1:4179/benchmarks/one-shot-showcase/direct/`
- `http://127.0.0.1:4179/benchmarks/one-shot-showcase/routed/`

## Trace

- Frozen content and behavior contract: [`input.json`](input.json)
- Candidate design mechanisms: [`sift-input.json`](sift-input.json)
- Deterministic Jev response: [`sift-replay.json`](sift-replay.json)
- Browser matrix and interpretation boundary: [`VALIDATION.md`](VALIDATION.md)
- Generated campaign: ignored output under
  `benchmarks/results/one-shot-showcase/`

The replay makes direction choice reproducible without claiming a live-provider
latency or token result. Visible output remains subjective evidence. The
delimiter-counter workflow remains JevRev's executable correctness and decision
proof.
