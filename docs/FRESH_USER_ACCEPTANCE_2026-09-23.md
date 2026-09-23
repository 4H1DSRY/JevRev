# Fresh-user acceptance: 2026-09-23

## Scope

The acceptance pass started from the README, installed and built the package,
ran the offline demos, then exercised Sift, Loop, Long, the evidence recorder,
provider configuration, packaging, and the bundled agent skill. The second pass
used the supplied test API credential through a temporary process environment;
the credential was not written to the repository, command arguments, or this
report.

## Findings and disposition

| Finding | Result |
| --- | --- |
| Creating Loop or Long below a missing parent returned a false “directory already exists” error. | Fixed: missing parents are created; the final store path remains exclusive. Added nested-path and existing-target tests. |
| `long watch --format json` is rejected, while `long status --format json` works. | Expected interface; documented the distinction in the README and Long design. |
| Windows `npm install` changed line endings in part of `package-lock.json` under npm 11.6.2. | Not changed: this was formatting-only tool-version churn, not a runtime defect. |

## Scenarios exercised

- README install, build, examples, demos, CLI help, and JSON output.
- Live Jev requests for Sift and a Loop audit, using the temporary credential.
- Invalid JSON, missing and unknown fields, oversized input, candidate limits,
  reordered replay data, and paths containing spaces or Unicode.
- Evidence command failure, timeout, output limits, workspace traversal,
  symlink/junction escapes, and atomic evidence updates.
- Loop multi-round execution, completion gates, replay integrity, concurrent
  mutations, and stale/live lock handling.
- Long duplicate retries, conflicting IDs, malformed and oversized batches,
  journal tampering, checkpoint recovery, Loop bridge digest checks, and watch
  behavior in terminal and redirected-output modes.
- Package installation and skill installation from the generated package.
- Real CLI creation of nested Loop and Long stores followed by a JSON Long
  status read.

All rejection cases in the matrix failed closed without recording false success
or partially advancing a store. No P0-P2 product defects were found in the
acceptance run.

## Verification

After the fix, `npm run check`, `npm test` (30 files, 274 tests),
`npm run build`, `npm run demo:all`, `npm run demo:workflow`,
`npm run demo:oneshot`, `python -m unittest discover -s runtime/tests -v`
(7 tests), and `npm pack --dry-run` all passed. The nested-store CLI check
created both stores successfully and returned parseable JSON from Long status.

## Long branch review

The committed `codex/jev-long-tui` branch was reviewed before considering a
push. Its TUI source and tests match the versions already present in this
checkout. Its remaining `watch` change suppresses errors from the selected
session as well as disappearing sibling sessions, which would hide corruption
in the session the user explicitly opened. The branch also carries an older,
conflicting README and unrelated history. GitHub `main` already has the same
TUI source blob as this checkout. There is no safe, unmerged Long feature to
push from that branch; the current Long implementation remains in the main
working line.
