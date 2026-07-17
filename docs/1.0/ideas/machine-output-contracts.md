# Machine-output contracts experiment

## Hypothesis and user value

Automation that consumes CueLine health output needs versioned, executable
contracts so a release cannot silently change field names, types, redaction or
nested structure.

## Change boundary

- Adds explicit schema identifiers to `doctor --json` and `routing --json`;
  preserves the existing `routing explain --json` identifier.
- Publishes strict JSON Schema 2020-12 contracts for those three outputs.
- Adds a real CLI contract validator to CI and a development-only Ajv
  dependency; CueLine runtime dependencies remain empty.
- Does not change human output, routing decisions, browser behavior, provider
  calls or durable state.

## Acceptance and adversarial cases

1. Real doctor, routing and routing-explain JSON validate against their schemas.
2. Every public object uses `additionalProperties: false`.
3. A secret-like top-level field is rejected.
4. A runner `argv` field is rejected.
5. Missing required fields and wrong schema versions are rejected.
6. Valid and invalid routing configuration variants retain parseable output.

## Verified evidence

- Targeted contract and CLI tests: 67 passed, 0 failed, including all three
  degraded invalid-config variants.
- Contract validation command: 3 passed, 0 failed.
- Full test suite: 494 passed, 0 failed after updating four authoritative
  machine-output snapshots for the new schema identifiers.
- TypeScript build: passed.
- Plugin validation: passed.
- `npm pack --dry-run`: passed; all three schema files and the validator are in
  the package, while Ajv remains development-only.

## Rollback

Revert this branch's commit. It owns the three schemas, validator, tests, Ajv
development dependency, CI step, schema identifiers and updated snapshots.

This experiment remains isolated on `codex/idea-machine-output-contract`. It
must not be merged into `main`; Vincent decides whether it is selected or
integrated.
