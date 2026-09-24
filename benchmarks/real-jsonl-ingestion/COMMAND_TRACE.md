# Command trace

The following sequence was executed by a fresh user-style agent in an
isolated workspace on 2026-09-23. Jev responses were replay fixtures;
commands, exit codes, evidence files, and local benchmark samples were real.

```text
npm install                                      exit 0
npm run build                                    exit 0
node dist/cli.js --help                         exit 0
node dist/cli.js sift ...                       exit 0; 6 evaluated, 2 kept
node scripts/create-evidence-template.mjs ...   exit 0; 2 packets created
node dist/cli.js evidence status ...             exit 0; collect_evidence
node dist/cli.js evidence run ... batch ...      exit 0; correctness passed
node dist/cli.js evidence run ... regex ...      exit 1; invalid 65 vs 184
node dist/cli.js evidence metric ...             exit 0; samples recorded
node dist/cli.js evidence artifact ...           exit 0; source recorded
node dist/cli.js evidence status ...             exit 0; regex rejected
node dist/cli.js decide ...                      exit 0; winner batch-index
node dist/cli.js loop create ...                 exit 0
node dist/cli.js loop next ...                   exit 0; round 1
node dist/cli.js loop evidence ...               exit 0; failing evidence kept
node dist/cli.js loop audit ...                  exit 0; fix_regression
node dist/cli.js loop next ...                   exit 0; round 2
node dist/cli.js loop evidence ...               exit 0; fresh evidence kept
node dist/cli.js loop audit ...                  exit 0; verify
node dist/cli.js loop next ...                   exit 0; completion plan
node dist/cli.js loop evidence ...               exit 0; fresh completion evidence
node dist/cli.js loop audit ...                  exit 0; completed
node dist/cli.js loop status ...                 exit 0; round 3 completed
node dist/cli.js long create ...                 exit 0
node dist/cli.js long ingest ...                 exit 0; accepted 13
node dist/cli.js long ingest ...                 exit 0; duplicates 13
node dist/cli.js long watch --interval-ms 1 ...  exit 1; minimum is 100 ms
node dist/cli.js long watch --interval-ms 100 ... exit 0; alerts rendered
node dist/cli.js long loop-audit ...             exit 0; bridge accepted
node src/one-shot.mjs                           exit 1; direct regex failed
```

The two important failures were not hidden: the regex correctness command
returned exit 1, and the first Long watch attempt used an invalid interval.
Both are part of the record because a useful workflow should expose friction,
not silently clean it up.

## Findings

- Sift reduced six proposals to two bounded probes.
- Evidence overruled the paper favorite with a real correctness failure.
- Loop did not stop on a plausible plan: it required a repair round and fresh
  completion evidence.
- Long remained observational. It reported a repeated failure and a protocol
  alert, then accepted the verified Loop bridge event.
- The run used no hosted API key. Replay provider tokens are fixture accounting,
  not a bill.
