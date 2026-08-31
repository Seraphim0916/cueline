#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CODEX_ROOT=${CODEX_HOME:-"$HOME/.codex"}
CLAUDE_ROOT=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}
SKILL_SOURCE="$ROOT/skills/cueline"
BIN_SOURCE="$ROOT/bin/cueline"
SKILL_TARGET="$CODEX_ROOT/skills/cueline"
BIN_TARGET="$HOME/.local/bin/cueline"
CLAUDE_SKILL_SOURCE="$ROOT/skills/cueline-host"
CLAUDE_LANE_SOURCE="$ROOT/bin/cueline-claude-desktop-lane"
CLAUDE_MAILBOX_SOURCE="$ROOT/bin/cueline-claude-desktop-mailbox"
CLAUDE_SKILL_TARGET="$CLAUDE_ROOT/skills/cueline-host"
CLAUDE_LANE_TARGET="$HOME/.local/bin/cueline-claude-desktop-lane"
CLAUDE_MAILBOX_TARGET="$HOME/.local/bin/cueline-claude-desktop-mailbox"

link_matches() {
  target=$1
  source=$2
  test -L "$target" && test "$(readlink "$target")" = "$source"
}

preflight_target() {
  target=$1
  source=$2
  if link_matches "$target" "$source"; then
    return 0
  fi
  if test -e "$target" || test -L "$target"; then
    printf 'CueLine: refusing to replace foreign path: %s\n' "$target" >&2
    return 1
  fi
}

install_codex_links() {
  test -f "$SKILL_SOURCE/SKILL.md" || {
    printf 'CueLine: missing skill source: %s\n' "$SKILL_SOURCE/SKILL.md" >&2
    exit 1
  }
  test -x "$BIN_SOURCE" || {
    printf 'CueLine: missing executable CLI source: %s\n' "$BIN_SOURCE" >&2
    exit 1
  }

  preflight_target "$SKILL_TARGET" "$SKILL_SOURCE" || exit 2
  preflight_target "$BIN_TARGET" "$BIN_SOURCE" || exit 2
  mkdir -p "$(dirname -- "$SKILL_TARGET")" "$(dirname -- "$BIN_TARGET")"
  link_matches "$SKILL_TARGET" "$SKILL_SOURCE" || ln -s "$SKILL_SOURCE" "$SKILL_TARGET"
  link_matches "$BIN_TARGET" "$BIN_SOURCE" || ln -s "$BIN_SOURCE" "$BIN_TARGET"
  printf 'CueLine installed:\n  skill: %s\n  CLI:   %s\n' "$SKILL_TARGET" "$BIN_TARGET"
}

preflight_claude_links() {
  test -f "$CLAUDE_SKILL_SOURCE/SKILL.md" || {
    printf 'CueLine: missing skill source: %s\n' "$CLAUDE_SKILL_SOURCE/SKILL.md" >&2
    exit 1
  }
  test -x "$CLAUDE_LANE_SOURCE" || {
    printf 'CueLine: missing executable CLI source: %s\n' "$CLAUDE_LANE_SOURCE" >&2
    exit 1
  }
  test -x "$CLAUDE_MAILBOX_SOURCE" || {
    printf 'CueLine: missing executable CLI source: %s\n' "$CLAUDE_MAILBOX_SOURCE" >&2
    exit 1
  }

  preflight_target "$CLAUDE_SKILL_TARGET" "$CLAUDE_SKILL_SOURCE" || exit 2
  preflight_target "$CLAUDE_LANE_TARGET" "$CLAUDE_LANE_SOURCE" || exit 2
  preflight_target "$CLAUDE_MAILBOX_TARGET" "$CLAUDE_MAILBOX_SOURCE" || exit 2
}

install_claude_links() {
  preflight_claude_links

  mkdir -p "$(dirname -- "$CLAUDE_SKILL_TARGET")" \
    "$(dirname -- "$CLAUDE_LANE_TARGET")" \
    "$(dirname -- "$CLAUDE_MAILBOX_TARGET")"
  link_matches "$CLAUDE_SKILL_TARGET" "$CLAUDE_SKILL_SOURCE" || \
    ln -s "$CLAUDE_SKILL_SOURCE" "$CLAUDE_SKILL_TARGET"
  link_matches "$CLAUDE_LANE_TARGET" "$CLAUDE_LANE_SOURCE" || \
    ln -s "$CLAUDE_LANE_SOURCE" "$CLAUDE_LANE_TARGET"
  link_matches "$CLAUDE_MAILBOX_TARGET" "$CLAUDE_MAILBOX_SOURCE" || \
    ln -s "$CLAUDE_MAILBOX_SOURCE" "$CLAUDE_MAILBOX_TARGET"

  printf 'CueLine installed:\n  Claude skill: %s\n  Claude lane: %s\n  Claude mailbox: %s\n' \
    "$CLAUDE_SKILL_TARGET" "$CLAUDE_LANE_TARGET" "$CLAUDE_MAILBOX_TARGET"
}

install_links() {
  case "$PLATFORM" in
    codex) install_codex_links ;;
    claude) install_claude_links ;;
    all)
      preflight_claude_links
      install_codex_links
      install_claude_links
      ;;
  esac
}

remove_owned_link() {
  target=$1
  source=$2
  if link_matches "$target" "$source"; then
    unlink "$target"
    printf 'removed %s\n' "$target"
  elif test -e "$target" || test -L "$target"; then
    printf 'preserved foreign path %s\n' "$target"
  fi
}

uninstall_codex_links() {
  remove_owned_link "$SKILL_TARGET" "$SKILL_SOURCE"
  remove_owned_link "$BIN_TARGET" "$BIN_SOURCE"
}

uninstall_claude_links() {
  remove_owned_link "$CLAUDE_SKILL_TARGET" "$CLAUDE_SKILL_SOURCE"
  remove_owned_link "$CLAUDE_LANE_TARGET" "$CLAUDE_LANE_SOURCE"
  remove_owned_link "$CLAUDE_MAILBOX_TARGET" "$CLAUDE_MAILBOX_SOURCE"
}

uninstall_links() {
  case "$PLATFORM" in
    codex) uninstall_codex_links ;;
    claude) uninstall_claude_links ;;
    all)
      uninstall_codex_links
      uninstall_claude_links
      ;;
  esac
}

usage() {
  printf 'usage: %s [--uninstall] [--codex-only | --claude-only]\n' "$0" >&2
  exit 2
}

PLATFORM=all
UNINSTALL=0

while test "$#" -gt 0; do
  case $1 in
    --uninstall)
      test "$UNINSTALL" -eq 0 || usage
      UNINSTALL=1
      ;;
    --codex-only)
      test "$PLATFORM" = all || usage
      PLATFORM=codex
      ;;
    --claude-only)
      test "$PLATFORM" = all || usage
      PLATFORM=claude
      ;;
    *) usage ;;
  esac
  shift
done

if test "$UNINSTALL" -eq 1; then
  uninstall_links
else
  install_links
fi
