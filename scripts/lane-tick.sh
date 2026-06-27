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
MKLOCK="$REPO_ROOT/.claude/esteira.lock.d"
LOCK_TTL=1800   # 30 min, same TTL as the prose /lane mkdir lock.

# --dry-run stays PURE/offline (no I/O, no lock dir) — detect it among the args.
DRY_RUN=0
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=1
done

# fd 9 → lock file; flock -n returns non-zero if another sweep already holds it.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "lane-tick: another sweep holds the lock — aborting." >&2
  exit 0
fi

# Unified lock (LIVE only): cross-honor the prose /lane mutual-exclusion lock so a code
# sweep and a `/loop /lane` sweep never run concurrently (preserving WIP=1 / one-driver).
# We replicate the prose lock's 30-min stale-TTL sweep: a dir older than the TTL is a
# dead holder (crashed before its EXIT trap) and is reclaimed. --dry-run skips this
# entirely so its behavior stays byte-for-byte identical (offline, no I/O).
if [ "$DRY_RUN" -eq 0 ]; then
  if [ -d "$MKLOCK" ]; then
    lock_age=$(( $(date +%s) - $(stat -c %Y "$MKLOCK") ))
    if [ "$lock_age" -ge "$LOCK_TTL" ]; then
      echo "lane-tick: stale prose lock (${lock_age}s) — reclaiming." >&2
      rm -rf "$MKLOCK"
    fi
  fi
  if ! mkdir "$MKLOCK" 2>/dev/null; then
    echo "lane-tick: prose /lane lock held (esteira.lock.d) — aborting." >&2
    exit 0
  fi
  trap 'rm -rf "$MKLOCK"' EXIT
fi

# Node is not on the default PATH in this environment — prepend it.
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"

# Deterministic core + live cutover. Under --dry-run, run.mjs derives and PRINTS the
# composite plan with NO side effects (no Linear writes, no git). Live (no --dry-run),
# run.mjs builds the board, decides, prints the plan, THEN dispatches it (lane/dispatch.mjs):
# the station workers (claude -p), the validated posting (lane/post.mjs) and the idempotent
# merge (lane/merge.mjs). The decision is always printed before any mutation.
node "$REPO_ROOT/lane/run.mjs" "$@"

# Live-cutover dispatch (lane/dispatch.mjs, invoked inside run.mjs's live path):
#   - active (understand|execution|review|merge|idle): the WIP=1 In-Progress action.
#       understand → /understand (## 🧭 Context Spec); execution → /execute (## 🔧 Work Log);
#       review → /review (## 🔍 Review). merge: NO worker — idempotent esteira/<ID> →
#       production, then move To Review + set the green terminal stage:done (SKILL c2/e);
#       a conflict is forward-only (logged, left for a human). idle: no-op.
#   - pretriage(from:Todo):   /triage (## 🎯 Pre-Triage), post, THEN move Todo → Triage.
#   - pretriage(from:Triage): legacy empty-Triage ticket — /triage in place, NO move.
#   - move-to-triage:         reconcile — a Todo already carrying a Pre-Triage: just move
#                             Todo → Triage (NO re-triage; idempotent by artifact).
#   Order: active → reconcile → pretriage (≤ PRETRIAGE_CAP=3). A ticket holding in Triage
#   WITH its Pre-Triage is a pure signal (human's turn) — the lane runs nothing on it.
#   Each worker (.claude/commands/*.md) does Recall, adopts its role and prints ONLY the
#   artifact; the driver runs lane/validate.mjs → lane/post.mjs (createComment →
#   kb/ingest.mjs → status/label). Worker error/timeout or a malformed artifact is logged
#   and SKIPPED — the d.0.6 gate refuses to post outside the template, and no single
#   failure aborts the sweep.
