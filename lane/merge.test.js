// Unit tests for the git merge helpers, with a STUBBED git runner (no real repo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAncestor, merge, cleanup } from './merge.mjs';

// Build a fake git runner driven by a handler that returns a string or throws.
function makeRunner(handler) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    return handler(args) ?? '';
  };
  run.calls = calls;
  return run;
}

test('isAncestor: true when merge-base --is-ancestor succeeds', () => {
  const run = makeRunner(() => '');
  assert.equal(isAncestor('WLN-1', 'production', run), true);
});

test('isAncestor: false when the runner throws', () => {
  const run = makeRunner(() => {
    throw new Error('not an ancestor (exit 1)');
  });
  assert.equal(isAncestor('WLN-1', 'production', run), false);
});

test('merge: already an ancestor → no checkout/merge, merged:false', () => {
  const run = makeRunner((args) => {
    if (args[0] === 'merge-base') return ''; // is-ancestor succeeds → already merged
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
  const r = merge('WLN-1', 'production', run);
  assert.deepEqual(r, { ok: true, merged: false, reason: 'already an ancestor' });
  // Guard: only the is-ancestor check ran.
  assert.deepEqual(run.calls, ['merge-base --is-ancestor WLN-1 production']);
});

test('merge: clean merge when not yet an ancestor → merged:true', () => {
  const run = makeRunner((args) => {
    if (args[0] === 'merge-base') throw new Error('not ancestor'); // needs merging
    return ''; // checkout + merge succeed
  });
  const r = merge('WLN-2', 'production', run);
  assert.equal(r.ok, true);
  assert.equal(r.merged, true);
  assert.ok(run.calls.some((c) => c.startsWith('checkout production')));
  assert.ok(run.calls.some((c) => c.startsWith('merge --no-ff')));
});

test('merge: conflict → blocked signal + merge --abort, no auto-resolve', () => {
  const run = makeRunner((args) => {
    if (args[0] === 'merge-base') throw new Error('not ancestor');
    if (args[0] === 'checkout') return '';
    if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('CONFLICT (content): merge conflict');
    if (args[0] === 'merge' && args[1] === '--abort') return '';
    return '';
  });
  const r = merge('WLN-3', 'production', run);
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.match(r.reason, /conflict/i);
  assert.ok(run.calls.includes('merge --abort'), 'aborts the half-done merge');
});

test('cleanup: prunes worktree and deletes the branch', () => {
  const run = makeRunner(() => '');
  const r = cleanup('WLN-4', { worktree: '/tmp/wt', run });
  assert.equal(r.ok, true);
  assert.ok(run.calls.some((c) => c.startsWith('worktree remove')));
  assert.ok(run.calls.some((c) => c.startsWith('branch -d')));
});

test('cleanup: collects errors but does not throw', () => {
  const run = makeRunner((args) => {
    if (args[0] === 'branch') throw new Error('branch not fully merged');
    return '';
  });
  const r = cleanup('WLN-5', { run });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /branch -d/);
});
