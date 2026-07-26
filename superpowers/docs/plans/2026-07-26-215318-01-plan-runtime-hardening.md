# CueLine runtime hardening

**Goal:** Ship unlimited controller rounds with a fail-closed stagnation fuse and a dry-run-first orphan run sweep in CueLine 0.7.0.

**Why planning required:** This changes persisted run semantics and public CLI/MCP contracts while preserving replay compatibility for existing runs.

**Acceptance:**

Outcome 1: Default runs have no finite round cap, explicit `maxRounds` remains durable, and repeated no-progress controller rounds terminate with `stagnation_detected`.

- Work: Choose and document a durable progress signal already present in controller events; add backward-compatible state, status, doctor, CLI, MCP, and documentation surfaces.
- Verify: focused red-green tests prove default runs continue beyond the former cap, explicit caps still fail with `MAX_ROUNDS_EXCEEDED`, old snapshots load, and stagnation produces terminal evidence plus a doctor finding.

Outcome 2: `cueline runs sweep` identifies only stale or missing runtime evidence for `running` runs, defaults to dry-run, and appends explicit fail-closed sweep evidence only with `--apply`.

- Work: Reuse runtime-fence freshness logic, preserve every run directory, expose machine-readable output, and surface orphan diagnosis naturally through run doctor.
- Verify: focused red-green tests prove stale orphan closure, live-run exclusion, dry-run immutability, event append, and JSON contract behavior.

Outcome 3: Release metadata and user documentation consistently describe CueLine 0.7.0.

- Work: Update package metadata, both plugin manifests, `src/version.ts`, five translated README files, changelog, CLI help, architecture/recovery docs, and affected schemas or diagrams.
- Verify: documentation guards, CLI contract validation, and `npm run release:check` report no findings.

Outcome 4: One local `main` commit contains the complete verified change.

- Work: Review the final diff, preserve unrelated work, and commit with repository-style `feat:` subject.
- Verify: full unit, integration, smoke, typecheck, candidate preflight, and temporary-fixture CLI/MCP runtime smokes pass; `git status` is clean and `main` is exactly one commit ahead of `d4b5539`.

**Safety and rollback:**

- Never read or write the real `~/.cueline`; every runtime check sets an isolated temporary `HOME` or explicit fixture home.
- No dependency, network, service restart, push, tag, release, publish, or run-directory deletion.
- Git baseline `d4b553992da07739ee259ac16e6651858a9cee19` is the rollback source. After commit, rollback is one local `git revert <commit>`; before commit, restore individual paths from that baseline.
- Stop after three consecutive failures with the same cause or on any protocol-compatibility ambiguity requiring a product decision.
