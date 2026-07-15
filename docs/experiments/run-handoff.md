# Experiment: safe run handoff

Branch: `codex/exp-run-handoff`

## Hypothesis

A new Codex session should be able to resume one exact CueLine run from a single
read-only packet instead of reconstructing controller identity, paths, jobs, and
ownership from chat history.

## Surface

```bash
cueline run handoff <run-id>
cueline run handoff <run-id> --json
cueline run handoff <run-id> --include-content --max-content-chars 2000
```

The public API exports `createCueLineRunHandoff()`,
`buildCueLineRunHandoff()`, and `renderCueLineRunHandoffMarkdown()`.

## Default packet

- Exact run, round, event sequence, phase, executor, and safe next action.
- Exact ChatGPT conversation and pending request identities.
- Submission, Pro-label, composer, and write-ahead evidence.
- Absolute CueLine home, run directory, event log, snapshot, and lease paths.
- Job IDs, keys, modes, status, task hashes, workdirs, and claim/start flags.
- Concrete CLI/API continuation example and the warning that Pro has no tools.

The default packet contains no user request, controller prompt, task text,
stdout, stderr, job output, claim proof, or token. `--include-content` adds only
request/task/final text under one shared total character budget; prompt and
worker output remain excluded.

## Review decision

Merge if cross-session recovery benefits from a canonical local packet. Reject
if all consumers should reconstruct handoff context directly from public APIs.
