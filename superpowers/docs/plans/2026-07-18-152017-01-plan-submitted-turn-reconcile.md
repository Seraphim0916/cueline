# Submitted turn reconciliation recovery

**Goal:** Recover one wedged normally submitted controller turn only when a fresh exact-conversation observation proves it was definitely not sent.
**Why planning is required:** This changes durable controller state, retry identity, and public CLI/API recovery behavior.
**Acceptance:** Preserve fail-closed ambiguity handling; never touch real `CUELINE_HOME`; never open a real browser in tests; create at most one retry; keep rollback at clean base `eb8c1a5`; stop before publish, push, version, or CHANGELOG changes.

### Outcome 1: Evidence-gated submitted-turn recovery
- Work: Reopen the exact conversation when needed, reject unhydrated observations, and atomically abandon/retry only for baseline-equal, request-absent, Pro-idle evidence.
- Verify: `npm run build && node --test dist/test/integration/lifecycle-recovery.test.js`

### Outcome 2: Honest operator surfaces
- Work: Scope reconciliation metadata to the current turn and expose a stable run-doctor finding with the safe recovery action.
- Verify: `npm run build && node --test dist/test/unit/run-doctor.test.js dist/test/unit/run-status.test.js dist/test/integration/cli.test.js`

### Outcome 3: No regressions and reviewable commit
- Work: Review the exact diff against all acceptance criteria, run the full supported checks and fake runtime smoke, then create one conventional commit.
- Verify: `npm test && npx tsc --noEmit`
