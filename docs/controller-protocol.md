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

Job states are `pending`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, or `ambiguous`. Before browser submission, a single output/error field is bounded to 40,000 characters and only the most recent 20 notices are sent. The local event log remains the recovery record.

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

`job_key` must be unique inside the command and match the supported identifier form. `mode` is `advise` or `work`. Optional fields are `required`, `timeout_ms`, `runner`, `workdir`, and `background`. `runner_id` is invalid and produces an explicit correction to use `runner`. The local runtime—not ChatGPT—resolves the configured executable. `lane` must be a listed available lane; a runner ID is not a lane name. When `runner` is supplied, it must name an enabled, available candidate in the selected lane. CueLine validates every new route in the dispatch before registering or starting any job. One invalid route rejects the whole command and requests a corrected envelope with the same pending identity. Repeating an already persisted deterministic job is ignored rather than spawned again.

If every job in one dispatch is `advise`, CueLine starts them concurrently and then reports all results. If any job is `work`, the entire dispatch remains serial in command order.

### `wait`

Waits for selected running jobs (`job_ids`) or all current running jobs when omitted. `wait_ms` is part of the v0.1 schema but does not override the supervisor's job timeout.

### `inspect`

Asks CueLine to present the currently persisted job state on the next round. It does not grant the web controller a new local inspection tool.

### `complete`

Ends the run with non-empty `final_delivery_text`. Completion is rejected while any required job remains `pending` or `running`; the controller receives a notice and must decide again. Completed required jobs may have failed—the controller is responsible for judging that evidence.

### `blocked`

Ends the run with a non-empty `reason` and optional `final_delivery_text`. This is a terminal, explicit statement that the controller cannot responsibly proceed with the available evidence or authority.

## Validation and repair

CueLine rejects missing markers, malformed JSON, invalid actions, stale identity, invalid supported-field values, duplicate `job_key` values, and unavailable pre-spawn routes with stable error codes. Only the supported fields retained by runtime validation can affect execution. CueLine then sends a validation error back to the same conversation with the same pending identity. By default, two repair attempts are allowed; exhaustion fails the local run rather than guessing a command.

The JSON Schema files under `schemas/` are publication references. Runtime structural validation is implemented locally and does not require a schema package.
