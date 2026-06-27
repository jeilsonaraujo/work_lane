// Unit tests for the LIVE dispatcher, fully OFFLINE: runClaude is mocked (never
// runs `claude -p`), the Linear client records createComment/updateIssue, merge is a
// stub, and KB ingest is stubbed. We inject the REAL post.mjs (so the d.0.6 validation
// gate is exercised end-to-end) with the ingest replaced by a no-op.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from './dispatch.mjs';
import { post as realPost } from './post.mjs';

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
  assert.equal(client.updates.length, 0); // no status/label change for understand
});

test('active execution → /execute (command name asymmetry)', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  await dispatch({
    plan: { active: { type: 'execution', ticket: ticket(11) }, reconcile: [], pretriage: [] },
    client, statuses, labels, runClaude, post,
  });
  assert.deepEqual(runClaude.calls, [{ cmd: 'execute', num: 11 }]);
  assert.match(client.comments[0].body, /## 🔧 Work Log/);
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
  assert.deepEqual(mergeCalls, ['esteira/WLN-13']);
  assert.equal(client.updates.length, 1);
  assert.deepEqual(client.updates[0], { id: 'iss-13', input: { stateId: 's-rev', labelIds: ['l-done'] } });
});

test('active merge conflict (blocked) → no move, logged', async () => {
  const client = makeClient();
  const runClaude = makeRunClaude();
  const merge = () => ({ ok: false, blocked: true, reason: 'merge conflict on esteira/WLN-14' });
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
