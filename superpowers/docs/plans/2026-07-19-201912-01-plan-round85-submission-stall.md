# Round 85 submission stall repair

**Goal:** Bound the attachment-to-send transition so a pre-click stall becomes durable `definitely_not_sent` evidence, an uncertain click remains ambiguous, and every owned call releases its runtime lease.
**Why planning is required:** This changes ChatGPT Web submission timing, durable recovery evidence, runtime ownership, and public browser-adapter evidence used to prevent duplicate sends.
**Acceptance:** Keep rollback at clean base `6f0f796`; never resend or mutate the existing round 85 run; preserve exact run/round/request/conversation/Pro gates; never auto-continue a `submission_started` wedge; stop before push, publish, release, version, or live round-85 recovery.

### Outcome 1: Bounded pre-click and click operations
- Work: Add a shorter inner browser-operation deadline after attachment hydration; classify a timeout before click invocation as `definitely_not_sent` and any timed-out or uncertain click as ambiguous without retry.
- Verify: `npm run build && node --test --test-name-pattern='pre-click|timed-out click|attachment.*send' dist/test/unit/browser-adapter.test.js`

### Outcome 2: Durable cleanup and explicit recovery
- Work: Persist request-correlated failure evidence, release the runtime lease before the caller deadline, and allow explicit read-only not-sent reconciliation of a `submission_started` attachment only when exact conversation, Pro, baseline, idle, request-absent, and residual-composer evidence agree.
- Verify: `npm run build && node --test --test-name-pattern='submission_started|pre-click|residual attachment' dist/test/integration/lifecycle-recovery.test.js dist/test/integration/minimal-loop.test.js`

### Outcome 3: No duplicate attachment, request, round, or send
- Work: Keep uncertain click outcomes fail-closed; preserve the existing explicit not-sent confirmation followed by same-round correlated recovery, reusing CueLine's own leftover attachment exactly once.
- Verify: `npm run build && node --test dist/test/unit/browser-adapter.test.js dist/test/integration/lifecycle-recovery.test.js`

### Outcome 4: Full verification and live-Pro handoff
- Work: Run the complete suite, typecheck, package/public-API checks, CLI/runtime smoke, review the exact diff, and document a real-Pro procedure as ready-to-verify without executing round 85.
- Verify: `npm test && npm run typecheck && npm pack --dry-run && npm run validate:cli-contracts`
