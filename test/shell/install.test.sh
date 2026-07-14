#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

HOME_ONE=$(mktemp -d /tmp/cueline-install-one.XXXXXX)
HOME="$HOME_ONE" CODEX_HOME="$HOME_ONE/.codex" sh "$ROOT/install.sh"

SKILL_LINK="$HOME_ONE/.codex/skills/cueline"
BIN_LINK="$HOME_ONE/.local/bin/cueline"
test -L "$SKILL_LINK" || fail "skill link missing"
test -L "$BIN_LINK" || fail "CLI link missing"
test "$(readlink "$SKILL_LINK")" = "$ROOT/skills/cueline" || fail "skill link target"
test "$(readlink "$BIN_LINK")" = "$ROOT/bin/cueline" || fail "CLI link target"
CLI_CONFIG=$(HOME="$HOME_ONE" CODEX_HOME="$HOME_ONE/.codex" "$BIN_LINK" config path)
test "$CLI_CONFIG" = "$ROOT/config/routing.default.json" || fail "installed CLI cannot resolve package root"

HOME="$HOME_ONE" CODEX_HOME="$HOME_ONE/.codex" sh "$ROOT/install.sh"
HOME="$HOME_ONE" CODEX_HOME="$HOME_ONE/.codex" sh "$ROOT/install.sh" --uninstall
test ! -e "$SKILL_LINK" && test ! -L "$SKILL_LINK" || fail "skill link survived uninstall"
test ! -e "$BIN_LINK" && test ! -L "$BIN_LINK" || fail "CLI link survived uninstall"

HOME_TWO=$(mktemp -d /tmp/cueline-install-two.XXXXXX)
mkdir -p "$HOME_TWO/.codex/skills" "$HOME_TWO/.local/bin"
printf 'foreign\n' > "$HOME_TWO/.codex/skills/cueline"
printf 'foreign\n' > "$HOME_TWO/.local/bin/cueline"
if HOME="$HOME_TWO" CODEX_HOME="$HOME_TWO/.codex" sh "$ROOT/install.sh"; then
  fail "installer overwrote foreign files"
fi
test "$(cat "$HOME_TWO/.codex/skills/cueline")" = "foreign" || fail "foreign skill changed"
test "$(cat "$HOME_TWO/.local/bin/cueline")" = "foreign" || fail "foreign CLI changed"
HOME="$HOME_TWO" CODEX_HOME="$HOME_TWO/.codex" sh "$ROOT/install.sh" --uninstall
test -f "$HOME_TWO/.codex/skills/cueline" || fail "uninstall removed foreign skill"
test -f "$HOME_TWO/.local/bin/cueline" || fail "uninstall removed foreign CLI"

printf 'PASS install, reinstall, uninstall, foreign-file preservation\n'
