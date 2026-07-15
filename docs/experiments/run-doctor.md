# Experiment: run doctor

Branch: `codex/exp-run-doctor`

## Hypothesis

A persisted CueLine run should explain *why* it is waiting or blocked without an
operator reconstructing state from `status`, `jobs`, leases, and event files.
The diagnosis must be read-only and must never turn ambiguous evidence into a
retry recommendation.

## Surface

```bash
cueline run doctor <run-id>
cueline run doctor <run-id> --json
```

The public API exports `diagnoseCueLineRun()` for persisted runs and
`diagnoseCueLineRunStatus()` for already loaded status summaries.

Each result includes a stable outcome, phase, event sequence, safe next action,
and findings with machine-readable codes, bounded evidence, and an operator
action. A blocked diagnosis exits `1`; healthy and action-required diagnoses
exit `0` because the command itself completed successfully.

## Safety properties

- Controller response pending means observe the exact turn and **do not resend**.
- Proposed caller work is distinguished from claimed or started work.
- Stale/unknown ownership, orphaned work, and ambiguous work are blockers.
- Timeout and failure are evidence for Pro, not implicit retry permission.
- Diagnosis does not append events, claim leases, cancel jobs, or drive a browser.

## Review decision

Merge if a single causal report is more useful than manually correlating the
existing read-only commands. Reject if the project should keep all policy out of
diagnostics and expose only raw state.
