// lane/merge.mjs — thin git helpers for the integrate step (impure, but the git
// runner is INJECTABLE so tests can stub it; no real repo mutation in tests).
//
// Branch base for review/merge is `production` (see CLAUDE.md). The merge is
// idempotent (guarded by an is-ancestor check) and NEVER auto-resolves conflicts:
// a conflict returns a `blocked` signal that becomes a human gate.

import { execFileSync } from 'node:child_process';

// Default runner: runs `git <args>` and returns stdout; throws on non-zero exit.
export function defaultRunner(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts });
}

// True iff `branch` is already an ancestor of `base` (nothing to merge).
export function isAncestor(branch, base = 'production', run = defaultRunner) {
  try {
    run(['merge-base', '--is-ancestor', branch, base]);
    return true;
  } catch {
    return false;
  }
}

// Idempotent merge of `branch` → `base`. Returns:
//   { ok:true,  merged:false, reason:'already an ancestor' }  — nothing to do
//   { ok:true,  merged:true }                                 — merged now
//   { ok:false, blocked:true, reason }                        — conflict/failure
export function merge(branch, base = 'production', run = defaultRunner) {
  if (isAncestor(branch, base, run)) {
    return { ok: true, merged: false, reason: 'already an ancestor' };
  }
  try {
    run(['checkout', base]);
    run(['merge', '--no-ff', '-m', `Merge ${branch} → ${base}`, branch]);
    return { ok: true, merged: true };
  } catch (err) {
    // No auto-resolve: abort the half-done merge and signal blocked.
    try {
      run(['merge', '--abort']);
    } catch {
      /* nothing to abort */
    }
    return {
      ok: false,
      blocked: true,
      reason: `merge conflict on ${branch} → ${base}: ${err && err.message ? err.message : err}`,
    };
  }
}

// Best-effort cleanup of the executor's isolation worktree + branch.
// `worktree` (path) is optional; when absent we only prune + delete the branch.
export function cleanup(branch, { worktree, run = defaultRunner } = {}) {
  const errors = [];
  if (worktree) {
    try {
      run(['worktree', 'remove', '--force', worktree]);
    } catch (e) {
      errors.push(`worktree remove: ${e && e.message ? e.message : e}`);
    }
  }
  try {
    run(['worktree', 'prune']);
  } catch (e) {
    errors.push(`worktree prune: ${e && e.message ? e.message : e}`);
  }
  try {
    run(['branch', '-d', branch]);
  } catch (e) {
    errors.push(`branch -d: ${e && e.message ? e.message : e}`);
  }
  return { ok: errors.length === 0, errors };
}
