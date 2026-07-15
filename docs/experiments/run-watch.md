# Experiment: bounded run watch

Branch: `codex/exp-run-watch`

## Hypothesis

Long controller runs should be observed through a short, cursor-based read call,
not by keeping one foreground tool call and runtime lease alive for minutes.

## Surface

```bash
cueline run watch <run-id> --after <event-sequence> [--timeout-ms <0..30000>] [--json]
```

The public API exports `waitForCueLineRunChange()`. It returns `changed`,
`terminal`, or `timed_out` with the latest full run status. The default timeout
is five seconds and the hard maximum is thirty seconds.

## Safety properties

- The observer never claims a runtime lease or appends an event.
- A cursor ahead of durable state is rejected instead of waiting forever.
- Terminal state returns immediately even when no newer event exists.
- Abort and timeout do not change ownership, retry a turn, or cancel work.
- Every follow-up call is independently recoverable from its sequence cursor.

## Review decision

Merge if short polling with a durable cursor better fits Codex tool lifetimes.
Reject if consumers should implement polling entirely outside CueLine.
