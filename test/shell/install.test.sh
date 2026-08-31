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

assert_link() {
  target=$1
  source=$2
  name=$3
  test -L "$target" || fail "$name link missing"
  test "$(readlink "$target")" = "$source" || fail "$name link target"
}

assert_absent() {
  target=$1
  name=$2
  if test -e "$target" || test -L "$target"; then
    fail "$name link survived uninstall"
  fi
}

install_for_home() {
  home=$1
  shift
  HOME="$home" CODEX_HOME="$home/.codex" CLAUDE_CONFIG_DIR="$home/.claude" \
    sh "$ROOT/install.sh" "$@"
}

HOME_ALL=$(mktemp -d /tmp/cueline-install-all.XXXXXX)
CODEX_SKILL_LINK="$HOME_ALL/.codex/skills/cueline"
CODEX_BIN_LINK="$HOME_ALL/.local/bin/cueline"
CLAUDE_SKILL_LINK="$HOME_ALL/.claude/skills/cueline-host"
CLAUDE_LANE_LINK="$HOME_ALL/.local/bin/cueline-claude-desktop-lane"
CLAUDE_MAILBOX_LINK="$HOME_ALL/.local/bin/cueline-claude-desktop-mailbox"

install_for_home "$HOME_ALL"
assert_link "$CODEX_SKILL_LINK" "$ROOT/skills/cueline" "Codex skill"
assert_link "$CODEX_BIN_LINK" "$ROOT/bin/cueline" "Codex CLI"
assert_link "$CLAUDE_SKILL_LINK" "$ROOT/skills/cueline-host" "Claude skill"
assert_link "$CLAUDE_LANE_LINK" "$ROOT/bin/cueline-claude-desktop-lane" "Claude lane"
assert_link "$CLAUDE_MAILBOX_LINK" "$ROOT/bin/cueline-claude-desktop-mailbox" "Claude mailbox"

install_for_home "$HOME_ALL"
assert_link "$CODEX_SKILL_LINK" "$ROOT/skills/cueline" "idempotent Codex skill"
assert_link "$CODEX_BIN_LINK" "$ROOT/bin/cueline" "idempotent Codex CLI"
assert_link "$CLAUDE_SKILL_LINK" "$ROOT/skills/cueline-host" "idempotent Claude skill"
assert_link "$CLAUDE_LANE_LINK" "$ROOT/bin/cueline-claude-desktop-lane" "idempotent Claude lane"
assert_link "$CLAUDE_MAILBOX_LINK" "$ROOT/bin/cueline-claude-desktop-mailbox" "idempotent Claude mailbox"

install_for_home "$HOME_ALL" --uninstall
assert_absent "$CODEX_SKILL_LINK" "Codex skill"
assert_absent "$CODEX_BIN_LINK" "Codex CLI"
assert_absent "$CLAUDE_SKILL_LINK" "Claude skill"
assert_absent "$CLAUDE_LANE_LINK" "Claude lane"
assert_absent "$CLAUDE_MAILBOX_LINK" "Claude mailbox"

HOME_CODEX_ONLY=$(mktemp -d /tmp/cueline-install-codex-only.XXXXXX)
install_for_home "$HOME_CODEX_ONLY" --codex-only
assert_link "$HOME_CODEX_ONLY/.codex/skills/cueline" "$ROOT/skills/cueline" "Codex-only skill"
assert_link "$HOME_CODEX_ONLY/.local/bin/cueline" "$ROOT/bin/cueline" "Codex-only CLI"
assert_absent "$HOME_CODEX_ONLY/.claude/skills/cueline-host" "Codex-only Claude skill"
assert_absent "$HOME_CODEX_ONLY/.local/bin/cueline-claude-desktop-lane" "Codex-only Claude lane"
assert_absent "$HOME_CODEX_ONLY/.local/bin/cueline-claude-desktop-mailbox" "Codex-only Claude mailbox"

HOME_CLAUDE_ONLY=$(mktemp -d /tmp/cueline-install-claude-only.XXXXXX)
install_for_home "$HOME_CLAUDE_ONLY" --claude-only
assert_absent "$HOME_CLAUDE_ONLY/.codex/skills/cueline" "Claude-only Codex skill"
assert_absent "$HOME_CLAUDE_ONLY/.local/bin/cueline" "Claude-only Codex CLI"
assert_link "$HOME_CLAUDE_ONLY/.claude/skills/cueline-host" "$ROOT/skills/cueline-host" "Claude-only skill"
assert_link "$HOME_CLAUDE_ONLY/.local/bin/cueline-claude-desktop-lane" "$ROOT/bin/cueline-claude-desktop-lane" "Claude-only lane"
assert_link "$HOME_CLAUDE_ONLY/.local/bin/cueline-claude-desktop-mailbox" "$ROOT/bin/cueline-claude-desktop-mailbox" "Claude-only mailbox"

HOME_SCOPED=$(mktemp -d /tmp/cueline-install-scoped.XXXXXX)
install_for_home "$HOME_SCOPED"
install_for_home "$HOME_SCOPED" --uninstall --claude-only
assert_link "$HOME_SCOPED/.codex/skills/cueline" "$ROOT/skills/cueline" "scoped Codex skill"
assert_link "$HOME_SCOPED/.local/bin/cueline" "$ROOT/bin/cueline" "scoped Codex CLI"
assert_absent "$HOME_SCOPED/.claude/skills/cueline-host" "scoped Claude skill"
assert_absent "$HOME_SCOPED/.local/bin/cueline-claude-desktop-lane" "scoped Claude lane"
assert_absent "$HOME_SCOPED/.local/bin/cueline-claude-desktop-mailbox" "scoped Claude mailbox"
install_for_home "$HOME_SCOPED" --uninstall --codex-only
assert_absent "$HOME_SCOPED/.codex/skills/cueline" "scoped Codex skill"
assert_absent "$HOME_SCOPED/.local/bin/cueline" "scoped Codex CLI"

HOME_FOREIGN_CLAUDE=$(mktemp -d /tmp/cueline-install-foreign-claude.XXXXXX)
mkdir -p "$HOME_FOREIGN_CLAUDE/.claude/skills/cueline-host"
printf 'foreign\n' > "$HOME_FOREIGN_CLAUDE/.claude/skills/cueline-host/keep"
if install_for_home "$HOME_FOREIGN_CLAUDE"; then
  fail "installer overwrote Claude foreign path"
else
  status=$?
fi
test "$status" -eq 2 || fail "Claude foreign path exit status"
test -d "$HOME_FOREIGN_CLAUDE/.claude/skills/cueline-host" || fail "Claude foreign directory changed"
test -f "$HOME_FOREIGN_CLAUDE/.claude/skills/cueline-host/keep" || fail "Claude foreign content changed"
assert_absent "$HOME_FOREIGN_CLAUDE/.codex/skills/cueline" "Claude foreign Codex skill"
assert_absent "$HOME_FOREIGN_CLAUDE/.local/bin/cueline" "Claude foreign Codex CLI"

HOME_FLAGS=$(mktemp -d /tmp/cueline-install-flags.XXXXXX)
if install_for_home "$HOME_FLAGS" --codex-only --claude-only >/dev/null 2>&1; then
  fail "installer accepted mutually exclusive flags"
else
  status=$?
fi
test "$status" -eq 2 || fail "mutually exclusive flags exit status"

printf 'PASS install, reinstall, uninstall, scoped install, foreign-file preservation, flag validation\n'
