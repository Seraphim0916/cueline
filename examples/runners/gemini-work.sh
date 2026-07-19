#!/usr/bin/env bash
# CueLine work runner: Gemini through Antigravity (agy), permission prompts skipped.
# argv: gemini-work.sh [model display string]; task arrives on stdin.
#
# WARNING: --dangerously-skip-permissions removes every interactive approval
# gate. The worker mutates whatever the dispatched task tells it to, with the
# full OS permissions of the CueLine process. Register this wrapper only when
# that is the intended contract; prefer the advise-only wrapper otherwise.
set -euo pipefail

MODEL="${1:-Gemini 3.1 Pro (High)}"
TASK="$(cat)"

# Stay on the existing agy CLI login and avoid browser interaction.
exec env -u GEMINI_API_KEY -u GOOGLE_API_KEY -u GOOGLE_AI_API_KEY \
  NO_BROWSER=1 \
  agy --dangerously-skip-permissions --add-dir "$PWD" \
  --model "$MODEL" \
  --print-timeout 570s \
  --print "$TASK"
