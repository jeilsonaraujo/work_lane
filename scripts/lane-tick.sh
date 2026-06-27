#!/usr/bin/env bash
# lane-tick.sh — single-instance headless sweep of the Work Lane CODE driver.
#
# `flock -n` gives a NON-BLOCKING, auto-released-on-death mutex: the kernel drops
# the lock when this process exits (even on crash), the headless analogue of the
# SKILL's atomic-mkdir lock. A second overlapping invocation fails the flock and
# exits 0 without touching Linear/git — preserving the WIP=1 / one-driver invariant.
#
# Usage:
#   scripts/lane-tick.sh --dry-run      # offline, prints the derived action, no I/O
#   scripts/lane-tick.sh                # live sweep (requires LINEAR_API_KEY)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$REPO_ROOT/.claude/esteira.lock"

# fd 9 → lock file; flock -n returns non-zero if another sweep already holds it.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "lane-tick: another sweep holds the lock — aborting." >&2
  exit 0
fi

# Node is not on the default PATH in this environment — prepend it.
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"

# 1. Deterministic core: derive the next action. Under --dry-run this has NO side
#    effects (no Linear writes, no git). The decision is always inspectable first.
node "$REPO_ROOT/lane/run.mjs" "$@"

# 2. Worker wiring (LIVE cutover — invoked by the live sweep, not under --dry-run).
#    Once run.mjs resolves an action, the matching station worker is dispatched
#    headlessly and its stdout artifact is validated + posted + ingested:
#
#      claude -p "/understand wln=51"   # → ## 🧭 Context Spec
#      claude -p "/execute   wln=51"    # → ## 🔧 Work Log
#      claude -p "/review    wln=51"    # → ## 🔍 Review
#
#    Each worker (.claude/commands/*.md) does Recall (kb/recall.mjs), adopts the
#    role from .claude/agents/<context-builder|executor|reviewer>.md, and prints
#    ONLY the artifact. The driver then runs lane/validate.mjs → lane/post.mjs
#    (createComment → kb/ingest.mjs → set status/label), and on an APPROVED review
#    lane/merge.mjs integrates esteira/<ID> → production. This dispatch is the
#    deliberately-deferred live-cutover layer (see the WLN-51 Work Log).
