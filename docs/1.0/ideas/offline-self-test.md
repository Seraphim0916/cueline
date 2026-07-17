# Offline self-test experiment

## Hypothesis and user value

An installed CueLine package should be able to prove that its controller loop,
process routing, durable state, final delivery, and run verifier work together
without opening a browser, contacting a provider, or touching the user's real
CueLine state.

## Change boundary

- Adds `cueline self-test [--json]`.
- Uses an in-memory deterministic controller and the current Node executable.
- Creates two private temporary directories for run state and workspace, then
  removes only those exact directories before returning.
- Does not read or write the configured `CUELINE_HOME` or `CUELINE_CONFIG`.
- Does not open a browser, use credentials, contact a provider, or make a
  network request.
- Does not relax production controller provenance checks. The in-memory
  adapter supplies fixed synthetic Pro-shaped evidence solely to exercise the
  existing verifier; the report is explicitly marked `offline: true`.

## Acceptance and adversarial cases

1. The isolated controller completes exactly two rounds.
2. One required local process job completes.
3. The expected final delivery is recorded.
4. `verifyCueLineRun` returns `verified` for the temporary run.
5. A pre-existing `CUELINE_DEPTH` fails closed with
   `NESTED_ROUTING_REJECTED` before temporary state is created.
6. Unknown CLI arguments return exit code 2.
7. JSON output contains neither temporary paths nor worker task content.
8. Temporary-directory counts are unchanged across a real CLI invocation.

## Verified evidence

- Targeted integration tests: 4 passed, 0 failed.
- Full test suite: 494 passed, 0 failed.
- TypeScript build: passed.
- Plugin validation: passed.
- Real `./bin/cueline self-test --json`: status `ok`; two controller rounds,
  one completed job, final delivery true, durable verification true.
- Temporary cleanup check: 0 matching directories before and after.

## Rollback

Revert this branch's commit. The feature owns only
`src/diagnostics/offline-self-test.ts`, its integration test and documentation,
plus the focused command/help additions in `src/cli/main.ts`.

This experiment remains isolated on `codex/idea-offline-self-test`. It must not
be merged into `main`; Vincent decides whether it is selected or integrated.
