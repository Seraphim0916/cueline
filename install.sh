#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CODEX_ROOT=${CODEX_HOME:-"$HOME/.codex"}
SKILL_SOURCE="$ROOT/skills/cueline"
BIN_SOURCE="$ROOT/bin/cueline"
SKILL_TARGET="$CODEX_ROOT/skills/cueline"
BIN_TARGET="$HOME/.local/bin/cueline"

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

install_links() {
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

uninstall_links() {
  remove_owned_link "$SKILL_TARGET" "$SKILL_SOURCE"
  remove_owned_link "$BIN_TARGET" "$BIN_SOURCE"
}

case ${1:-} in
  "") install_links ;;
  --uninstall) uninstall_links ;;
  *)
    printf 'usage: %s [--uninstall]\n' "$0" >&2
    exit 2
    ;;
esac
