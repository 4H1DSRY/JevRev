---
name: jevrev
description: Use JevRev to shortlist structured implementation approaches before spending repository-changing effort.
---

# JevRev

Use this skill when a task has several plausible implementation mechanisms and
the cost of trying the wrong one is material. JevRev is a shortlist step; it
does not edit the repository or replace tests.

## Calling convention

1. Read enough of the repository to state the goal and context.
2. Record hard and soft constraints and falsifiable success criteria.
3. Draft 3–7 materially different candidate cards. Each card needs:
   `id`, `title`, `summary`, `mechanism`, `assumptions`, `risks`, `validation`,
   and `effort` (`small`, `medium`, or `large`).
4. Write the request JSON to a temporary file or pipe it to stdin.
5. Run:

```bash
jevrev run --input request.json --format json
```

For a local judge:

```bash
jevrev run --input request.json --provider semif --format json
```

6. Implement only the IDs in `selected`. Treat `review` as an explicit pause
   for a human decision or another candidate pass.
7. Verify the implementation with the validation commands in the card. A
   JevRev decision is not evidence that the code works.

## Practical limits

- Keep candidate mechanisms genuinely different; wording variants waste the
  comparison budget.
- Put hard constraints in `task.constraints` with `kind: "hard"`.
- Keep `max_survivors` at 1–3 for normal coding work.
- Do not put secrets, complete repositories, or command logs into the request
  unless they are necessary evidence.
- Preserve the JSON result in the handoff so the downstream implementation
  step can explain why an option survived.

## Provider addresses

- Jev: `POST https://api.typesafe.ai/v1/systemone` by default; override the
  root with `--jev-url` or `JEVREV_JEV_URL`.
- SemIf: `POST http://127.0.0.1:4878/v1/chat/completions` by default; override
  with `--semif-url` or `JEVREV_SEMIF_URL`.
- Legacy reranker: `POST http://127.0.0.1:4877/v1/score`.

Credentials belong in `JEVREV_JEV_API_KEY` or `TYPESAFE_API_KEY`, never in a
command-line argument.
