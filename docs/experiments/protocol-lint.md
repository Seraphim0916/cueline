# Experiment: controller protocol lint

Branch: `codex/exp-protocol-lint`

## Hypothesis

Known Pro contract mistakes should be found offline in one pass before they
consume another controller round or touch durable run state.

## Surface

```bash
cueline protocol lint response.txt \
  --run-id run_... \
  --round 3 \
  --request-id msg_... \
  --json
```

The public API exports `lintControllerCommandText()`. It accepts either a raw
JSON object or the last complete `<CueLineControl>` envelope.

## Checks unique to this experiment

- Exact run, round, and request identity.
- `prompt` versus required `task`.
- `runner_id` versus supported `runner`.
- A runner ID mistakenly placed in `lane`, using active routing evidence.
- Unknown top-level and job fields.
- Fields that exist in the protocol but belong to a different action.
- Required absolute `workdir` for caller `work`.
- Existing schema, duplicate-key, mode, timeout, and terminal-field validation.

Invalid JSON produces bounded diagnostics and does not echo the source. Linting
never rewrites, sends, accepts, or records a command.

## Review decision

Merge if preventing wasted Pro repair rounds is worth a new offline CLI surface.
Reject if the runtime validator alone should remain the only contract authority.
