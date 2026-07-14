# Runner contract

## Routing happens before spawn

A controller job names a lane, not arbitrary shell text. CueLine loads an enabled lane and examines candidates in configured order. Disabled or unavailable candidates are skipped before execution. The first available candidate becomes the resolved route.

Once its process starts, the selection is final. A failure, timeout, empty result, or ambiguous side effect is returned to the controller; CueLine does not silently try the next candidate.

## Registered executable boundary

Every process uses a `RunnerSpec`:

```ts
interface RunnerSpec {
  jobId: string;
  runId?: string;
  jobKey?: string;
  argv: readonly string[];
  stdin?: string;
  mode: "advise" | "work";
  timeoutMs: number;
  background?: boolean;
  lane?: string;
  task?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}
```

`argv[0]` must exactly match an executable registered from the loaded routing config. A route explicitly chooses task input through a `{task}` argv placeholder or stdin; materialization rejects a missing or duplicate placement. Other supported placeholders are expanded as individual argv elements before spawn. CueLine invokes Node's process API with `shell: false`; it does not concatenate controller text into a shell command. Registration is an allow-list, not a sandbox: the registered program still has the OS permissions of the local CueLine process.

## Execution semantics

- `CUELINE_DEPTH=1` is injected into the child.
- A pre-existing `CUELINE_DEPTH` in the process or job environment rejects nested routing.
- Standard input is closed unless the route explicitly selects stdin task input; stdout and stderr are captured as UTF-8 text.
- The effective output is stdout, stderr, or both in that order.
- Exit code 0 is `succeeded`; a non-zero exit or spawn error is `failed`.
- At timeout CueLine sends `SIGTERM`, then schedules `SIGKILL` after 250 ms if needed; the result is `timed_out`.
- Cancellation uses the same owned-process termination path. `advise` becomes `cancelled`; started `work` becomes `ambiguous`.
- Empty output is explicitly recorded instead of being replaced with invented content.
- Results are never marked retryable by the process runner.

For an unsuccessful `work` job, `ambiguousSideEffects` is true because CueLine cannot prove how much mutation occurred before failure. That flag is preserved in the job result. Such work must be inspected and explicitly decided by the web controller; it must not be auto-retried.

## Foreground and background

A foreground `start` waits for the single execution and persists its terminal status. A background `start` persists and returns `running` immediately while the same completion promise continues. `waitForCompletion(jobId)` returns that completion or the last persisted status. The supervisor persists run ID, job key, lane, mode, and child PID after spawn. PID is observability, not stand-alone cancellation authority.

`cancel(jobId)` and `cancelAll()` operate only on executions owned by the current supervisor. Cross-session CLI cancellation is a durable request consumed by that owner. CueLine does not kill an unverified process merely because a stale status file contains a PID.

The controller loop derives deterministic job IDs from the run, `job_key`, and job specification. A duplicate dispatch already present in run state is recorded as a notice and skipped. This is the run-level at-most-once gate; it is not a distributed transaction across hosts.

## Availability

Candidate availability is evaluated locally through an injected function/checker or candidate-ID map. Availability means only that the runtime has accepted the candidate before spawn. It does not guarantee that credentials, network services, model quotas, or the target worker will remain healthy after start.

## Side-effect policy

Use `advise` for analysis that should not mutate the target. Use `work` only when the user request authorizes local changes and the selected worker has a suitable work directory. CueLine does not broaden permissions from `advise` to `work`, publish externally, or grant browser ChatGPT direct machine access.

The controller chooses the intent; Codex and local runtime policy remain responsible for whether that intent is authorized and executable.

## Bundled default

The `default` lane contains one candidate, `codex-default`. It runs `codex exec` without a shell, sends the task over stdin, uses the requested work directory, and maps `advise` to `read-only` and `work` to `workspace-write`. The default route is unavailable when the `codex` executable is not on `PATH`; CueLine reports that fact instead of selecting an unrelated worker.
