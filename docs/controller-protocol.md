# Controller protocol

CueLine `0.1` exchanges text messages with one ChatGPT web conversation. Each outbound prompt contains a `<CueLineObservation>` JSON document. The controller must answer with exactly one usable command in a complete `<CueLineControl>` envelope.

## Identity

Every command must echo these values from the pending observation:

- `protocol`: `cueline/0.1`
- `run_id`: the current persisted run
- `round`: the current controller round
- `request_id`: the deterministic identity of this observation

A stale or mismatched value is rejected. CueLine parses only the **last complete** control envelope, which prevents an older example earlier in the assistant response from winning.

## Observation

```json
{
  "protocol": "cueline/0.1",
  "run_id": "run-example",
  "round": 2,
  "request_id": "msg-example",
  "user_request": "Review the repository and recommend the next change.",
  "jobs": [
    {
      "job_id": "job-example",
      "job_key": "review",
      "required": true,
      "status": "succeeded",
      "output": "Review evidence"
    }
  ],
  "notices": []
}
```

Job states are `pending`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, or `ambiguous`. Successful jobs with non-empty stdout use stdout as controller evidence instead of a combined stdout/stderr stream. Failed and timed-out jobs retain bounded diagnostic error evidence. All job evidence in one controller observation shares a global 12,000-character budget; omitted content is reported once with the exact omitted count. After an accepted `inspect(job_ids)`, the named jobs receive that budget before unrelated jobs. Full stdout/stderr remain in local job status, and only the most recent 20 notices are sent. The local event log remains the recovery record.

## Command envelope

```text
<CueLineControl>
{
  "protocol": "cueline/0.1",
  "run_id": "run-example",
  "round": 2,
  "request_id": "msg-example",
  "action": "complete",
  "final_delivery_text": "The review is complete."
}
</CueLineControl>
```

Text outside the envelope is not executed. CueLine does not request or consume private chain-of-thought; concise user-facing rationale may stay outside the envelope.

## Actions

### `dispatch`

Schedules one or more local jobs.

```json
{
  "protocol": "cueline/0.1",
  "run_id": "run-example",
  "round": 1,
  "request_id": "msg-example",
  "action": "dispatch",
  "jobs": [
    {
      "job_key": "architecture-review",
      "lane": "default",
      "mode": "advise",
      "task": "Read the supplied repository evidence and propose a plan.",
      "required": true,
      "timeout_ms": 120000,
      "background": false
    }
  ]
}
```

`job_key` must be unique inside the command and match the supported identifier form. `mode` is `advise` or `work`. Optional fields are `required`, `timeout_ms`, `runner`, `workdir`, and `background`. `runner_id` is invalid and produces an explicit correction to use `runner`. The local runtime—not ChatGPT—resolves the configured executable. `lane` must be a listed available lane; a runner ID is not a lane name. When `runner` is supplied, it must name an enabled, available candidate in the selected lane. CueLine validates every new route in the dispatch before registering or starting any job. One invalid route rejects the whole command and requests a corrected envelope with the same pending identity. Repeating an already persisted deterministic job is ignored rather than executed again.

The default executor is `caller`. It persists pending `advise` jobs and returns them as `awaiting_caller`. A caller `work` job must include an absolute `workdir`; it returns as `awaiting_caller_work` without executing. The current Codex must acquire a claim bound to run/job/task hash/workdir/caller/fencing token, durably start it before mutation, heartbeat long work, and submit the result with the exact proof. A non-success after start is reported as `ambiguous`, not as proof that no side effect occurred. A `dispatch` alone never means local work started. The web controller has no local tool access or implicit knowledge of local paths/repository layout. Local evidence must include absolute paths, relevant code excerpts, exact code/error identifiers, and an explicit request for any missing local evidence.

The `process` executor requires both `executor: "process"` and `allowProcessExecution: true`; each non-terminal continuation repeats the second authorization. A supplied process `workdir` must be absolute. When omitted, CueLine writes the local runtime's resolved absolute workspace into the accepted command before hashing, registration, or execution. This keeps replay bound to the same directory after a restart. Independent `advise` jobs run with a default global concurrency of two and a default per-lane limit of two (both configurable). If any job is `work`, the entire batch remains serial in command order.

### `wait`

Waits for selected running jobs (`job_ids`) or all current running jobs when omitted. `wait_ms` is part of the v0.1 schema but does not override the supervisor's job timeout.

### `inspect`

Asks CueLine to present the currently persisted job state on the next round. Named `job_ids` receive the bounded evidence budget before unrelated jobs, so a completed result is not reduced to status merely because earlier jobs consumed the prompt budget. It does not grant the web controller a new local inspection tool.

### `complete`

Ends the run with non-empty `final_delivery_text`. Completion is rejected while any required or optional job remains `pending` or `running`; the controller receives a notice and must wait, inspect, cancel, or otherwise settle every job before deciding again. Terminal jobs may have failed—the controller is responsible for judging that evidence.

### `blocked`

Ends the run with a non-empty `reason` and optional `final_delivery_text`. Like `complete`, it is rejected while any required or optional job remains active so terminalization cannot orphan background work. Once jobs are settled, it is an explicit statement that the controller cannot responsibly proceed with the available evidence or authority.

## Validation and repair

CueLine rejects missing markers, malformed JSON, invalid actions, stale identity, invalid supported-field values, duplicate `job_key` values, and unavailable pre-spawn routes with stable error codes. Only the supported fields retained by runtime validation can affect execution. CueLine then sends a validation error back to the same conversation with the same pending identity. By default, two repair attempts are allowed; exhaustion fails the local run rather than guessing a command.

The JSON Schema files under `schemas/` are publication references. Runtime structural validation is implemented locally and does not require a schema package.
