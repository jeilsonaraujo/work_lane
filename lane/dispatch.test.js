// Unit tests for the LIVE dispatcher, fully OFFLINE: runClaude is mocked (never
// runs `claude -p`), the Linear client records createComment/updateIssue, merge is a
// stub, and KB ingest is stubbed. We inject the REAL post.mjs (so the d.0.6 validation
// gate is exercised end-to-end) with the ingest replaced by a no-op.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch as rawDispatch } from './dispatch.mjs';
import { post as realPost } from './post.mjs';

// Default-inject SAFE stubs for the impure git/cleanup deps so no test ever shells out to
// real git (worktree add/remove, branch -d). A test that asserts on them passes its own,
// which overrides via the trailing spread.
const dispatch = (opts) => rawDispatch({ git: () => '', cleanup: () => ({ ok: true, errors: [] }), ...opts });

// Canonical artifacts (one per station), valid against validate.mjs.
const ART = {
  triage: '## 🎯 Pre-Triage\n\nObjective: do the thing.',
  understand: '## 🧭 Context Spec\n\n**Blockers:** none\n\nApproach…',
  execution: '## 🔧 Work Log\n\n**Status:** SUCCESS\n\nDone.',
  review: '## 🔍 Review\n\n**Verdict:** APPROVED\n\nMeets the criteria.',
};

// A Linear client that records its mutating calls (no network).
function makeClient() {
  const comments = [];
  const updates = [];
  return {
    createComment: async (issueId, body) => {
      comments.push({ issueId, body });
      return { id: `c-${comments.length}` };
    },
    updateIssue: async (id, input) => {
      updates.push({ id, input });
      return { id, labels: { nodes: [] } };
    },
    comments,
    updates,
  };
}

// runClaude stub: maps the /command to its canonical artifact, records calls.
function makeRunClaude(overrides = {}) {
  const calls = [];
  const fn = ({ cmd, num }) => {
    calls.push({ cmd, num });
    if (overrides[cmd]) return overrides[cmd];
    const station = cmd === 'execute' ? 'execution' : cmd;
    return { status: 0, signal: null, stdout: ART[station] ?? '', stderr: '', error: null };
  };
  fn.calls = calls;
  return fn;
}

// Inject the real post with a no-op ingest so we exercise validate()+createComment
// without spawning kb/ingest.mjs.
const ingestStub = () => ({ ok: true });
const post = (args) => realPost({ ...args, ingest: ingestStub });

// git stub for worktree management (execution isolation): records args, succeeds.
function makeGit() {
  const calls = [];
  const fn = (args) => { calls.push(args); return ''; };
  fn.calls = calls;
  return fn;
}
// cleanup stub (post-merge branch/worktree tidy): records branches, never throws.
function makeCleanup() {
  const calls = [];
  const fn = (branch) => { calls.push(branch); return { ok: true, errors: [] }; };
  fn.calls = calls;
  return fn;
}

const statuses = { Todo: 's-todo', Triage: 's-triage', 'In Progress': 's-prog', 'To Review': 's-rev', Done: 's-done' };
const labels = { 'stage:done': 'l-done' };

const ticket = (n, over = {}) => ({ id: `iss-${n}`, identifier: `WLN-${n}`, number: n, ...over });

const logs = () => {
  const lines = [];
  const log = (m) => lines.push(m);
  log.lines = lines;
  return log;
};

// --- active station runs ------------------------------------------------------

test('active understand → /understand, posts Context Spec', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  await dispatch({
    plan: { active: { type: 'understand', ticket: ticket(10) }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post,
  });
  assert.deepEqual(runClaude.calls, [{ cmd: 'understand', num: 10 }]);
  assert.equal(client.comments.length, 1);
  assert.match(client.comments[0].body, /## 🧭 Context Spec/);
  assert.equal(client.updates.length, 0); // stage:understand absent in fixture → label left
});

// Regression: the active station must reconcile its stage:* mirror when the label
// resolves. Previously runStation was called WITHOUT labelId, so the label was never set
// (a ticket would sit in In Progress with no stage label).
test('active understand sets the stage:understand label when resolved', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  await dispatch({
    plan: { active: { type: 'understand', ticket: ticket(10) }, reconcile: [], pretriage: [] },
    client, statuses, labels: { 'stage:understand': 'l-und' }, runClaude, post,
  });
  assert.deepEqual(client.updates, [{ id: 'iss-10', input: { labelIds: ['l-und'] } }]);
});

test('active execution → /execute (command name asymmetry)', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  await dispatch({
    plan: { active: { type: 'execution', ticket: ticket(11) }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post, git: makeGit(),
  });
  assert.deepEqual(runClaude.calls, [{ cmd: 'execute', num: 11 }]);
  assert.match(client.comments[0].body, /## 🔧 Work Log/);
});

// Isolation: execution must run in a dedicated worktree (cwd) so the executor's branch
// checkout never moves the main repo HEAD. The worktree is created before and removed
// after the run, and runClaude receives its path as cwd.
test('active execution runs in an isolated worktree (add → cwd → remove)', async () => {
  const client = makeClient();
  const cwds = [];
  const runClaude = (args) => { cwds.push(args.cwd); return { status: 0, signal: null, stdout: ART.execution, stderr: '', error: null }; };
  const git = makeGit();
  await dispatch({
    plan: { active: { type: 'execution', ticket: ticket(11) }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post, git,
  });
  // worktree created (add) then removed (remove --force), with a non-empty cwd in between.
  assert.ok(git.calls.some((a) => a[0] === 'worktree' && a[1] === 'add'), 'worktree add');
  assert.ok(git.calls.some((a) => a[0] === 'worktree' && a[1] === 'remove'), 'worktree remove');
  assert.ok(cwds[0] && cwds[0].includes('lane-exec-WLN-11'), 'runClaude got the worktree cwd');
});

test('execution worktree is removed even when the worker fails', async () => {
  const client = makeClient();
  const runClaude = () => ({ status: 1, signal: null, stdout: '', stderr: 'boom', error: null });
  const git = makeGit();
  const log = logs();
  await dispatch({
    plan: { active: { type: 'execution', ticket: ticket(11) }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post, git, log,
  });
  assert.ok(git.calls.some((a) => a[0] === 'worktree' && a[1] === 'remove'), 'worktree removed in finally');
});

// understand / review are read-only — they must NOT spin up a worktree.
test('understand does not create a worktree (read-only)', async () => {
  const git = makeGit();
  await dispatch({
    plan: { active: { type: 'understand', ticket: ticket(10) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude: makeRunClaude(), post, git,
  });
  assert.equal(git.calls.length, 0);
});

test('active review → /review', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  await dispatch({
    plan: { active: { type: 'review', ticket: ticket(12) }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post,
  });
  assert.deepEqual(runClaude.calls, [{ cmd: 'review', num: 12 }]);
  assert.match(client.comments[0].body, /## 🔍 Review/);
});

// --- idle / merge: no worker --------------------------------------------------

test('active idle → no worker, no writes', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  await dispatch({
    plan: { active: { type: 'idle' }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post,
  });
  assert.equal(runClaude.calls.length, 0);
  assert.equal(client.comments.length, 0);
  assert.equal(client.updates.length, 0);
});

test('active merge → merge() + updateIssue(To Review + stage:done), no worker', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  const mergeCalls = [];
  const merge = (branch) => { mergeCalls.push(branch); return { ok: true, merged: true }; };
  await dispatch({
    plan: { active: { type: 'merge', ticket: ticket(13) }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post, merge,
  });
  assert.equal(runClaude.calls.length, 0);
  assert.deepEqual(mergeCalls, ['WLN-13']);
  assert.equal(client.updates.length, 1);
  assert.deepEqual(client.updates[0], { id: 'iss-13', input: { stateId: 's-rev', labelIds: ['l-done'] } });
});

test('successful merge tidies up the branch via cleanup()', async () => {
  const cleanup = makeCleanup();
  await dispatch({
    plan: { active: { type: 'merge', ticket: ticket(13) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude: makeRunClaude(),
    post, merge: () => ({ ok: true, merged: true }), cleanup,
  });
  assert.deepEqual(cleanup.calls, ['WLN-13']);
});

test('blocked merge does NOT run cleanup (branch kept for the human)', async () => {
  const cleanup = makeCleanup();
  await dispatch({
    plan: { active: { type: 'merge', ticket: ticket(14) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude: makeRunClaude(),
    post, merge: () => ({ ok: false, blocked: true, reason: 'conflict' }), cleanup,
  });
  assert.equal(cleanup.calls.length, 0);
});

test('active merge conflict (blocked) → no move, logged', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  const merge = () => ({ ok: false, blocked: true, reason: 'merge conflict on WLN-14' });
  const log = logs();
  await dispatch({
    plan: { active: { type: 'merge', ticket: ticket(14) }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post, merge, log,
  });
  assert.equal(client.updates.length, 0);
  assert.ok(log.lines.some((l) => /blocked/.test(l)));
});

test('merge with stage:done absent → move without the label', async () => {
  const client = makeClient();
  const merge = () => ({ ok: true, merged: false, reason: 'already an ancestor' });
  await dispatch({
    plan: { active: { type: 'merge', ticket: ticket(15) }, reconcile: [], pretriage: [] },
    client, statuses, labels: {}, runClaude: makeRunClaude(), post, merge,
  });
  assert.deepEqual(client.updates[0], { id: 'iss-15', input: { stateId: 's-rev', labelIds: undefined } });
});

// --- pretriage ----------------------------------------------------------------

test('pretriage from Todo → /triage, post, THEN move Todo → Triage', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  await dispatch({
    plan: { active: { type: 'idle' }, reconcile: [], pretriage: [{ type: 'pretriage', ticket: ticket(20), from: 'Todo' }] },
    client, statuses, labels, runClaude, post,
  });
  assert.deepEqual(runClaude.calls, [{ cmd: 'triage', num: 20 }]);
  assert.match(client.comments[0].body, /## 🎯 Pre-Triage/);
  assert.equal(client.updates.length, 1);
  assert.deepEqual(client.updates[0], { id: 'iss-20', input: { stateId: 's-triage' } });
});

test('pretriage from Triage (legacy) → /triage in place, NO move', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  await dispatch({
    plan: { active: { type: 'idle' }, reconcile: [], pretriage: [{ type: 'pretriage', ticket: ticket(21), from: 'Triage' }] },
    client, statuses, labels, runClaude, post,
  });
  assert.deepEqual(runClaude.calls, [{ cmd: 'triage', num: 21 }]);
  assert.equal(client.comments.length, 1);
  assert.equal(client.updates.length, 0); // no status change
});

// --- reconcile ----------------------------------------------------------------

test('reconcile move-to-triage → updateIssue only, no worker', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  await dispatch({
    plan: { active: { type: 'idle' }, reconcile: [{ type: 'move-to-triage', ticket: ticket(30) }], pretriage: [] },
    client, statuses, labels, runClaude, post,
  });
  assert.equal(runClaude.calls.length, 0);
  assert.equal(client.comments.length, 0);
  assert.deepEqual(client.updates, [{ id: 'iss-30', input: { stateId: 's-triage' } }]);
});

// --- ordering -----------------------------------------------------------------

test('order is active → reconcile → pretriage', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  const order = [];
  // Wrap post to record the order of comments relative to updates.
  const tracedPost = async (args) => { order.push(`post:${args.station}`); return post(args); };
  const tracedClient = {
    ...client,
    updateIssue: async (id, input) => { order.push(`update:${id}`); return client.updateIssue(id, input); },
  };
  await dispatch({
    plan: {
      active: { type: 'review', ticket: ticket(40) },
      reconcile: [{ type: 'move-to-triage', ticket: ticket(41) }],
      pretriage: [{ type: 'pretriage', ticket: ticket(42), from: 'Todo' }],
    },
    client: tracedClient, statuses, labels, runClaude, post: tracedPost,
  });
  // active review post, then reconcile update, then pretriage post + move.
  assert.deepEqual(order, ['post:review', 'update:iss-41', 'post:triage', 'update:iss-42']);
});

// --- robustness ---------------------------------------------------------------

test('invalid artifact → NOT posted (validation gate), sweep continues', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude({ understand: { status: 0, signal: null, stdout: 'garbage, no header', stderr: '', error: null } });
  const log = logs();
  await dispatch({
    plan: { active: { type: 'understand', ticket: ticket(50) }, reconcile: [], pretriage: [{ type: 'pretriage', ticket: ticket(51), from: 'Todo' }] },
    client, statuses, labels, runClaude, post, log,
  });
  // understand artifact rejected → no comment for it; pretriage still ran.
  assert.equal(client.comments.length, 1);
  assert.match(client.comments[0].body, /## 🎯 Pre-Triage/);
  assert.ok(log.lines.some((l) => /rejected/.test(l)));
});

test('runClaude non-zero exit → logged, no post, sweep continues', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude({ review: { status: 1, signal: null, stdout: '', stderr: 'boom', error: null } });
  const log = logs();
  await dispatch({
    plan: { active: { type: 'review', ticket: ticket(60) }, reconcile: [{ type: 'move-to-triage', ticket: ticket(61) }], pretriage: [] },
    client, statuses, labels, runClaude, post, log,
  });
  assert.equal(client.comments.length, 0); // review never posted
  assert.deepEqual(client.updates, [{ id: 'iss-61', input: { stateId: 's-triage' } }]); // reconcile still ran
  assert.ok(log.lines.some((l) => /exit status 1/.test(l)));
});

test('runClaude killed by SIGTERM (timeout) → logged, no throw', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude({ execute: { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null } });
  const log = logs();
  await dispatch({
    plan: { active: { type: 'execution', ticket: ticket(70) }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post, log,
  });
  assert.equal(client.comments.length, 0);
  assert.ok(log.lines.some((l) => /SIGTERM/.test(l)));
});

// --- activeAdvanced return signal (drives the run.mjs drain loop) ---------------

test('returns activeAdvanced=false for idle', async () => {
  const r = await dispatch({
    plan: { active: { type: 'idle' }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude: makeRunClaude(), post,
  });
  assert.deepEqual(r, { activeAdvanced: false });
});

test('returns activeAdvanced=true when an active station posts a valid artifact', async () => {
  const r = await dispatch({
    plan: { active: { type: 'execution', ticket: ticket(11) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude: makeRunClaude(), post,
  });
  assert.equal(r.activeAdvanced, true);
});

test('returns activeAdvanced=false when the worker exits non-zero', async () => {
  const runClaude = makeRunClaude({ review: { status: 1, signal: null, stdout: '', stderr: 'boom', error: null } });
  const r = await dispatch({
    plan: { active: { type: 'review', ticket: ticket(60) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude, post, log: logs(),
  });
  assert.equal(r.activeAdvanced, false);
});

test('returns activeAdvanced=false when the worker is killed (timeout)', async () => {
  const runClaude = makeRunClaude({ execute: { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null } });
  const r = await dispatch({
    plan: { active: { type: 'execution', ticket: ticket(70) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude, post, log: logs(),
  });
  assert.equal(r.activeAdvanced, false);
});

test('returns activeAdvanced=false when the artifact is rejected by the validation gate', async () => {
  const runClaude = makeRunClaude({ understand: { status: 0, signal: null, stdout: 'garbage, no header', stderr: '', error: null } });
  const r = await dispatch({
    plan: { active: { type: 'understand', ticket: ticket(50) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude, post, log: logs(),
  });
  assert.equal(r.activeAdvanced, false);
});

test('returns activeAdvanced=true on a successful merge', async () => {
  const merge = () => ({ ok: true, merged: true });
  const r = await dispatch({
    plan: { active: { type: 'merge', ticket: ticket(13) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude: makeRunClaude(), post, merge,
  });
  assert.equal(r.activeAdvanced, true);
});

test('returns activeAdvanced=true when the branch is already an ancestor (idempotent merge)', async () => {
  const merge = () => ({ ok: true, merged: false, reason: 'already an ancestor' });
  const r = await dispatch({
    plan: { active: { type: 'merge', ticket: ticket(15) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude: makeRunClaude(), post, merge,
  });
  assert.equal(r.activeAdvanced, true);
});

test('returns activeAdvanced=false on a merge conflict (blocked)', async () => {
  const merge = () => ({ ok: false, blocked: true, reason: 'merge conflict on WLN-14' });
  const r = await dispatch({
    plan: { active: { type: 'merge', ticket: ticket(14) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude: makeRunClaude(), post, merge, log: logs(),
  });
  assert.equal(r.activeAdvanced, false);
});

test('returns activeAdvanced=false for an unknown active type', async () => {
  const r = await dispatch({
    plan: { active: { type: 'bogus', ticket: ticket(99) }, reconcile: [], pretriage: [] },
    client: makeClient(), statuses, labels, runClaude: makeRunClaude(), post, log: logs(),
  });
  assert.equal(r.activeAdvanced, false);
});

test('returns activeAdvanced=false when the active station throws', async () => {
  const throwingClient = {
    createComment: async () => { throw new Error('network down'); },
    updateIssue: async (id, input) => ({ id }),
  };
  const r = await dispatch({
    plan: { active: { type: 'understand', ticket: ticket(80) }, reconcile: [], pretriage: [] },
    client: throwingClient, statuses, labels, runClaude: makeRunClaude(), post, log: logs(),
  });
  assert.equal(r.activeAdvanced, false);
});

test('client.createComment throwing in active does NOT abort reconcile/pretriage', async () => {
  const throwingClient = {
    createComment: async () => { throw new Error('network down'); },
    updateIssue: makeClient().updateIssue,
    updates: [],
  };
  // capture updates on this client
  const updates = [];
  throwingClient.updateIssue = async (id, input) => { updates.push({ id, input }); return { id }; };
  const log = logs();
  await dispatch({
    plan: {
      active: { type: 'understand', ticket: ticket(80) },
      reconcile: [{ type: 'move-to-triage', ticket: ticket(81) }],
      pretriage: [],
    },
    client: throwingClient, statuses, labels, runClaude: makeRunClaude(), post, log,
  });
  assert.deepEqual(updates, [{ id: 'iss-81', input: { stateId: 's-triage' } }]);
  assert.ok(log.lines.some((l) => /threw/.test(l)));
});
