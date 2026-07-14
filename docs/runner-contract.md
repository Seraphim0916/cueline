# Runner contract

## Caller execution is the default

`startCueLineRun` and `runCueLine` default to `executor: "caller"`. With the built-in browser, one durable submission returns `awaiting_controller`; later continuations observe the same URL/request once without resending. A validated dispatch then persists pending jobs and returns them to the current Codex; it does not spawn `codex exec`. The caller executes each exact `advise` task with its own permitted local tools, submits one terminal result through `submitCueLineCallerJobResult`, and continues the same run. Duplicate terminal submissions return `already_terminal`.

The ChatGPT web controller only emits a text command. It does not inspect the repository, call tools, or run the job itself. Caller execution rejects `work` with `CALLER_WORK_REQUIRES_CLAIM`; use caller `advise`, or explicitly opt into the process executor after the user has authorized local mutation.

## Process routing happens before spawn

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
- Full stdout and stderr are persisted separately. Successful non-empty stdout is the preferred controller evidence; combined output remains diagnostic status only.
- Exit code 0 is `succeeded`; a non-zero exit or spawn error is `failed`.
- At timeout CueLine sends `SIGTERM`, then schedules `SIGKILL` after 250 ms if needed; the result is `timed_out`.
- Cancellation uses the same owned-process termination path. `advise` becomes `cancelled`; started `work` becomes `ambiguous`.
- The owned POSIX process group is checked and settled on normal leader exit, cancellation, and timeout so surviving descendants cannot make a dead leader look terminal.
- Any non-normal owned process-loop exit, including controller repair or round-limit exhaustion, cancels and settles every active job before releasing runtime ownership. `advise` becomes `cancelled` when termination is proven; started `work` remains `ambiguous` when side effects cannot be disproved.
- Empty output is explicitly recorded instead of being replaced with invented content.
- Results are never marked retryable by the process runner.

For an unsuccessful `work` job, `ambiguousSideEffects` is true because CueLine cannot prove how much mutation occurred before failure. That flag is preserved in the job result. Such work must be inspected and explicitly decided by the web controller; it must not be auto-retried.

## Foreground and background

A foreground `start` waits for the single execution and persists its terminal status. A background `start` persists and returns `running` immediately while the same completion promise continues. `waitForCompletion(jobId)` returns that completion or the last persisted status. The supervisor persists run ID, job key, lane, mode, and child PID after spawn. PID is observability, not stand-alone cancellation authority.

`cancel(jobId)` and `cancelAll()` operate only on executions owned by the current supervisor. Cross-session CLI cancellation is a durable request consumed by that owner. CueLine does not kill an unverified process merely because a stale status file contains a PID.

The controller loop derives deterministic job IDs from the run, `job_key`, and job specification. A duplicate dispatch already present in run state is recorded as a notice and skipped. Caller result submission and continuation are runtime-lease serialized, so the first terminal evidence committed for a job wins and later submissions return `already_terminal`.

That lease is **not** an execution claim. Two sessions can both perform the same caller `advise` task before either one submits a result. Coordinate a single caller executor when resuming a handoff. This is why caller mode is restricted to non-mutating `advise`; `work` is rejected until CueLine has a duplicate-safe execution claim.

## Process concurrency

Explicit process execution defaults to at most two active jobs globally and two active jobs per lane. `maxConcurrency` and `laneConcurrency` may reduce or increase those limits. An all-`advise` batch uses the bounded scheduler; a batch containing any `work` job is always serial in command order.

## Availability

Candidate availability is evaluated locally through an injected function/checker or candidate-ID map. Availability means only that the runtime has accepted the candidate before spawn. It does not guarantee that credentials, network services, model quotas, or the target worker will remain healthy after start.

## Side-effect policy

Use `advise` for analysis that should not mutate the target. Use `work` only when the user request authorizes local changes and the selected worker has a suitable work directory. CueLine does not broaden permissions from `advise` to `work`, publish externally, or grant browser ChatGPT direct machine access.

The controller chooses the intent; Codex and local runtime policy remain responsible for whether that intent is authorized and executable.

## Bundled process route

When `executor: "process"` is selected, the `default` lane contains one candidate, `codex-default`. It runs `codex exec` without a shell, sends the task over stdin, uses the requested work directory, and maps `advise` to `read-only` and `work` to `workspace-write`. The route is unavailable when the `codex` executable is not on `PATH`; CueLine reports that fact instead of selecting an unrelated worker.
