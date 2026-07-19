#!/usr/bin/env bash
# CueLine work runner: Grok with permission prompts bypassed.
# Task arrives on stdin. No -m flag: stays on the grok CLI's default model.
#
# WARNING: bypassPermissions removes every interactive approval gate. The
# worker mutates whatever the dispatched task tells it to, with the full OS
# permissions of the CueLine process. Register this wrapper only when that is
# the intended contract; prefer the advise-only candidate otherwise.
set -euo pipefail

TMP="$(mktemp)"
trap '{ rm -f -- "$TMP"; } 2>/dev/null || true' EXIT
cat > "$TMP"

# Keep the subscription login path; an exported XAI_API_KEY would silently
# switch grok to API-key billing.
env -u XAI_API_KEY grok --cwd "$PWD" \
  --no-memory --no-subagents --no-alt-screen \
  --output-format plain --verbatim \
  --permission-mode bypassPermissions \
  --prompt-file "$TMP"
