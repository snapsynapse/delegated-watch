#!/bin/sh
# Claude Code PostToolUse hook wrapper for call-time usage capture.
#
# Perplexity and TypeSafe publish no usage endpoint, so the usage object in
# each response is the only token count that will ever exist for a call. This
# hands every Bash tool result that touched either API to its capture script,
# which keeps the counters and nothing else. The file name predates TypeSafe;
# the installer finds the hook by it, so it stays.
#
# It runs on every Bash tool call in every project, so the common case has to
# be cheap: the guards below cost a shell pattern match, and Node starts only
# when the command actually reached one of the two APIs.
#
# Register it with: node scripts/install-perplexity-hook.mjs
#
# Always exits 0. A capture problem must never fail the command that triggered it.

set -u

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

input=$(cat)

case "$input" in
  *api.perplexity.ai*)
    printf '%s' "$input" | node "$REPO_ROOT/scripts/perplexity-capture.mjs" --hook || true
    ;;
esac

case "$input" in
  *api.typesafe.ai*)
    printf '%s' "$input" | node "$REPO_ROOT/scripts/typesafe-capture.mjs" --hook || true
    ;;
esac

exit 0
