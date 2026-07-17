# Node 26 support contract experiment

## Hypothesis and user value

CueLine should preserve Node 22 as its minimum while proving current even-LTS
compatibility through one synchronized engines, CI and documentation contract.

## Change boundary

- Expands the existing Ubuntu/macOS CI matrix from Node 22/24 to 22/24/26.
- Keeps `engines.node` at `>=22`.
- Synchronizes all five README development sections and the compatibility
  matrix.
- Adds a read-only contract validator; it does not install, download or switch
  Node versions.
- Does not change runtime behavior, browser control, routing, state or provider
  access.

## Acceptance and adversarial cases

1. Engine requirement is exactly `>=22`.
2. CI Node majors are exactly 22, 24 and 26 on Ubuntu and macOS.
3. All localized README files and compatibility docs name the tested majors.
4. Removing Node 26, leaving one README stale or changing engines makes the
   validator fail.
5. The current Node 26 runtime passes the complete local release-facing checks.

## Verified evidence

- Node support validator: passed on Node 26.3.0.
- Targeted contract tests: 4 passed, 0 failed.
- Full test suite on Node 26.3.0: 494 passed, 0 failed.
- Fake smoke on Node 26.3.0: 6 passed, 0 failed.
- Shell install/reinstall/uninstall/foreign-file preservation: passed.
- npm tarball global install, skill install, doctor and uninstall: passed.
- TypeScript build, plugin validation and `npm pack --dry-run`: passed.

## Remaining external verification

The workflow now requests Node 26 on both Ubuntu and macOS, but this isolated
branch has not been pushed. Therefore GitHub-hosted Node 26 results remain
unverified until Vincent selects and explicitly authorizes remote integration.

## Rollback

Revert this branch's commit. It owns the CI matrix addition, support validator,
tests, documentation synchronization and this experiment record.

This experiment remains isolated on `codex/idea-node26-contract`. It must not be
merged into `main`; Vincent decides whether it is selected or integrated.
