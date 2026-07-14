#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
WORK=$(mktemp -d /tmp/cueline-npm-package.XXXXXX)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir -p "$WORK/pack" "$WORK/home" "$WORK/fake-bin"
printf '#!/bin/sh\nexit 0\n' > "$WORK/fake-bin/codex"
chmod +x "$WORK/fake-bin/codex"

TARBALL=$(cd "$ROOT" && npm pack --pack-destination "$WORK/pack" --silent)
npm install --global --prefix "$WORK/prefix" "$WORK/pack/$TARBALL" --ignore-scripts --silent

CLI="$WORK/prefix/bin/cueline"
CODEX_ROOT="$WORK/home/.codex"
SKILL_LINK="$CODEX_ROOT/skills/cueline"
TEST_PATH="$WORK/prefix/bin:$WORK/fake-bin:$PATH"

test -x "$CLI" || fail "global CLI missing"
test "$(HOME="$WORK/home" CODEX_HOME="$CODEX_ROOT" PATH="$TEST_PATH" "$CLI" version)" = "0.1.0" || fail "global CLI version"
API_PATH=$(HOME="$WORK/home" CODEX_HOME="$CODEX_ROOT" PATH="$TEST_PATH" "$CLI" api path)
test -f "$API_PATH" || fail "api path does not reach packaged API"
node --input-type=module --eval 'const api = await import(process.argv[1]); if (typeof api.runCueLine !== "function") process.exit(1)' "$API_PATH" || fail "packaged API is not importable"

HOME="$WORK/home" CODEX_HOME="$CODEX_ROOT" PATH="$TEST_PATH" "$CLI" install
test -L "$SKILL_LINK" || fail "skill link missing"
test -f "$SKILL_LINK/SKILL.md" || fail "skill link does not reach packaged skill"

DOCTOR_OUTPUT=$(HOME="$WORK/home" CODEX_HOME="$CODEX_ROOT" PATH="$TEST_PATH" "$CLI" doctor) || fail "doctor command failed"
printf '%s\n' "$DOCTOR_OUTPUT" | grep -Eq '^status[[:space:]]+ok$' || fail "doctor did not report ok"

HOME="$WORK/home" CODEX_HOME="$CODEX_ROOT" PATH="$TEST_PATH" "$CLI" uninstall
test ! -e "$SKILL_LINK" && test ! -L "$SKILL_LINK" || fail "skill link survived uninstall"

printf 'PASS npm tarball global install, skill install, doctor, uninstall\n'
