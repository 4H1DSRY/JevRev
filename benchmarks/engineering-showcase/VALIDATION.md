# Webhook engineering case validation

Validated locally: 2026-09-23.

## Executed contract

`npm run demo:engineering` ran the baseline, copied the repair into one working
`ledger.mjs`, and recorded three commands in each of three rounds. Results:

| Round | Tenant | Concurrent delivery | Failure retry | Loop outcome |
| --- | --- | --- | --- | --- |
| Baseline | fail | fail | pass | `fix_regression` |
| Repaired | pass | pass | pass | `verify` |
| Fresh completion | pass | pass | pass | `completed` |

The captured baseline source is
`sha256:76b2741f0ab815a82a9a019d75c9d23125e7838d156651f6002228a0227a7ae8`.
Rounds two and three share the repaired source
`sha256:b36573509f7d7c75614a3c0b6c24e4a04969b9e5254d78912abddd2598f9c1b1`.
`.gitattributes` pins the case source and capture to LF so these source hashes
remain stable on Windows checkouts.
Every command observation was recorded with an exit code, duration, and output
SHA-256 digest. Round three has fresh criterion links for all three commands.

The committed [capture](capture/) has seven verified Loop events and three
verified Long audit observations. Loop journal head:
`b6d0ab1befea3022b3598d2b5964c64a07987767e45b04b80575ae2c6496f23e`.
Long journal head:
`6d0dad0b825948bcc96370bfe57db6987d50c262bb3dd49b50b8bd78a2a65f02`.
The bridge rejected a deliberately wrong evidence hash and suppressed an
identical replay. These checks occur in the actual driver, before it writes
`trace.json`.

`npm test -- --run tests/engineering-showcase.test.ts` passed. The tests
replay the driver, inspect evidence and journal outcomes, call the live
workbench API, compare its module hashes with the captured revisions, and
assert the tenant/race/retry observations.

## Browser capture

The workbench was opened in local Microsoft Edge at `127.0.0.1:4178`. The
browser received live JSON from `/api/replay`; the audit strip read the
committed capture. All three tabs were selected, `Run live replay` was used,
ArrowRight selected the next tab, and the tenant and handler-count differences
were inspected. The page reported
zero JavaScript or console errors and no horizontal overflow at 1440 CSS
pixels or 390 CSS pixels.

- [Full developer workbench screenshot](../../.github/assets/engineering-showcase/webhook-workbench.png):
  1440 × 1133, SHA-256
  `2CFB8DD098E787F0C68151C91EEB09BD29801DE349CF09B404D90E65D38CB6CF`.
- [Tenant comparison screenshot](../../.github/assets/engineering-showcase/webhook-tenant.png):
  unmodified 896 × 417 scenario-section capture from a 960-pixel viewport,
  SHA-256 `D4429C1F14AAA8DD2DD632CCE42181139A4F3A7D9BE3794103D6C73B94790EC1`.
- [Concurrent delivery screenshot](../../.github/assets/engineering-showcase/webhook-race.png):
  unmodified 896 × 390 scenario-section capture from a 960-pixel viewport,
  SHA-256 `816A8AF73276A7014BDC7FB845BDA5485E8FF78A48FF222DBEEA66738FEB9A16`.
- [Tenant mobile screenshot](../../.github/assets/engineering-showcase/webhook-mobile.png):
  unmodified 358 × 694 scenario-section capture from a 390-pixel viewport,
  SHA-256 `FAFD8931C6B8D5BCFCA224511559709D0338F1C00EFA6E57195557E7B1575995`.

The visual design is a restrained developer workbench: native font stack,
neutral surfaces, table values, and color reserved for observed pass/fail
states. The screenshots show actual browser output from the live modules.

## Claim boundary

The browser replay and captured CLI audit are separate runs. The browser
compares the same source revisions and scenario functions, while the saved
Loop/Long journals document the audited run. The fixture is in memory and
does not establish durable or distributed exactly-once processing.
