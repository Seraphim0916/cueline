# CueLine MCP stdio server

**Goal:** Add a zero-runtime-dependency `cueline mcp serve` command that exposes CueLine's bounded programmatic API through a compliant MCP stdio server.
**Why planning is required:** This adds a public CLI and protocol contract, passes through process-execution authority and caller fencing, and spans transport, API adapters, tests, documentation, and the built CLI surface.
**Acceptance:** Protocol revision `2025-11-25` initialization, tools discovery, tool calls, malformed-message handling, and EOF shutdown work over newline-delimited stdio; all tools preserve existing API schemas and bounded evidence; explicit process-execution authorization and caller identity/fencing semantics remain unchanged; the full suite, typecheck, manual CLI smoke, diff review, commit, and clean-worktree checks pass.

### Outcome 1: Establish the protocol boundary
- Work: Add focused failing tests for initialization, lifecycle, tools discovery, malformed JSON-RPC, graceful EOF shutdown, and one adapter call per exposed tool without launching a browser.
- Verify: `npm run build && node --test dist/test/integration/mcp-server.test.js`

### Outcome 2: Add the thin MCP adapter and CLI command
- Work: Hand-roll newline-delimited JSON-RPC stdio handling and map MCP tools directly to existing API functions, preserving option types, caller identity/fencing, bounded results, and explicit `allowProcessExecution` behavior.
- Verify: focused MCP tests plus `npx tsc --noEmit`

### Outcome 3: Document and prove the public surface
- Work: Add only the English README quick-start wiring example, review the complete task diff, then exercise `node bin/cueline mcp serve` with initialize, initialized notification, and tools/list input.
- Verify: `npm test`; `npx tsc --noEmit`; manual stdio smoke with parsed JSON assertions; `git diff --check`

### Outcome 4: Deliver the authorized branch commit
- Work: Commit only task-scoped files on `feature/mcp-server` with a conventional feature commit; do not push, publish, bump version, edit translated READMEs, or edit `CHANGELOG.md`.
- Verify: `git branch --show-current`; `git log -1 --format='%H %s'`; `git status --short --branch`

### Recovery and stop conditions
- Rollback point: `eb8c1a5491945ec6e5290973fd8ed4b3b5a4cfd4` on the clean starting branch.
- Preserve unrelated user changes if any appear; stop before committing if the branch changes, the worktree gains unrelated edits, or the adapter would require weakening existing security checks.
- MCP shutdown follows the specification's stdio EOF/process-signal lifecycle; no non-standard shutdown RPC is introduced.
