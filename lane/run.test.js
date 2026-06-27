// Unit tests for the DRAIN loop (run.mjs), fully OFFLINE: buildBoard, decide and dispatch
// are all injected — no Linear, no git, no `claude -p`. The loop re-reads the board each
// iteration (a scripted sequence of mocked boards) and chains stations while the active slot
// advances, stopping at idle, on an unchanged progress signature, or at DRAIN_CAP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drain, DRAIN_CAP } from './run.mjs';

// Silence the per-iteration plan JSON (run.mjs console.log) during a drain.
async function quietDrain(opts) {
  const realLog = console.log;
  console.log = () => {};
  try {
    return await drain(opts);
  } finally {
    console.log = realLog;
  }
}

// A board whose active slot sits at `stage` (null stage → idle / nothing in progress).
const boardAt = (stage, ticket = 'WLN-58') =>
  stage === null ? { inProgress: null } : { inProgress: { ticket: { identifier: ticket }, stage } };

// decide stub: derive the active action straight from the board's stage. Review-approved
// is modeled as the 'merge' stage so the merge branch is exercised. pretriage/reconcile are
// passed through from the board so we can assert they're dispatched once.
const decideFromBoard = (board) => ({
  active: board.inProgress
    ? { type: board.inProgress.stage, ticket: board.inProgress.ticket }
    : { type: 'idle' },
  pretriage: board.pretriage ?? [],
  reconcile: board.reconcile ?? [],
});

// dispatch stub: records every plan it received and returns activeAdvanced from a script.
// Mirrors the real dispatch contract — an idle active slot NEVER advances; otherwise it
// defaults to true so the loop keeps draining until the board sequence runs dry.
function makeDispatch(advanceScript = []) {
  const calls = [];
  const fn = async ({ plan }) => {
    let advanced;
    if (plan.active.type === 'idle') advanced = false;
    else advanced = calls.length < advanceScript.length ? advanceScript[calls.length] : true;
    calls.push(plan);
    return { activeAdvanced: advanced };
  };
  fn.calls = calls;
  return fn;
}

// buildBoard stub: yields the next board in `seq` per iteration (clamps to the last).
function makeBuildBoard(seq) {
  let i = 0;
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const board = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return board;
  };
  fn.calls = calls;
  return fn;
}

const base = (over) => ({
  client: {}, projectId: 'P', statuses: {}, labels: {}, decide: decideFromBoard, ...over,
});

// (a) drains understand → execution → review → merge in one call, in order, then idle.
test('drains N stations in a single invocation, in order', async () => {
  const buildBoard = makeBuildBoard([
    boardAt('understand'),
    boardAt('execution'),
    boardAt('review'),
    boardAt('merge'),
    boardAt(null), // ticket moved to To Review → active slot idle
  ]);
  const dispatch = makeDispatch();
  const { iterations } = await quietDrain(base({ buildBoard, dispatch }));

  const types = dispatch.calls.map((p) => p.active.type);
  assert.deepEqual(types, ['understand', 'execution', 'review', 'merge', 'idle']);
  // idle dispatch returns activeAdvanced=false → Guard 2 stops the loop on that 5th iteration.
  assert.equal(iterations, 5);
});

// (b) stops at idle immediately when there's nothing in progress.
test('stops at idle (one iteration, no advance)', async () => {
  const buildBoard = makeBuildBoard([boardAt(null)]);
  const dispatch = makeDispatch([false]); // idle → no advance
  const { iterations } = await quietDrain(base({ buildBoard, dispatch }));
  assert.equal(iterations, 1);
  assert.equal(dispatch.calls.length, 1);
  assert.equal(dispatch.calls[0].active.type, 'idle');
});

// (c) stops on an unchanged progress signature even if dispatch reports advanced=true
// (a valid artifact posted but the derived stage didn't move — a looping/skipped artifact).
test('stops on unchanged progress signature despite activeAdvanced=true', async () => {
  const buildBoard = makeBuildBoard([
    boardAt('execution'),
    boardAt('execution'), // same ticket:stage as before → Guard 1 break (before dispatch)
  ]);
  const dispatch = makeDispatch([true, true]); // would keep going if not for Guard 1
  const { iterations } = await quietDrain(base({ buildBoard, dispatch }));
  // Iteration 0 dispatches; iteration 1 sees the same signature and breaks BEFORE dispatch.
  assert.equal(iterations, 2);
  assert.equal(dispatch.calls.length, 1);
});

// (d) respects DRAIN_CAP as the hard backstop (signature changes every iteration so neither
// other guard fires; the board ticket id advances forever).
test('respects DRAIN_CAP as the iteration backstop', async () => {
  let n = 0;
  const buildBoard = async () => boardAt('execution', `WLN-${n++}`); // distinct sig each time
  const dispatch = makeDispatch(); // always advances
  const { iterations } = await quietDrain(base({ buildBoard, dispatch }));
  assert.equal(iterations, DRAIN_CAP);
  assert.equal(dispatch.calls.length, DRAIN_CAP);
});

// (e) pre-triage / reconcile are dispatched ONLY on iteration 0 (PRETRIAGE_CAP stays
// per-sweep), even while the active slot keeps draining across iterations.
test('pre-triage/reconcile dispatched only on iteration 0', async () => {
  const pretriage = [{ type: 'pretriage', ticket: { identifier: 'WLN-90' }, from: 'Todo' }];
  const reconcile = [{ type: 'move-to-triage', ticket: { identifier: 'WLN-91' } }];
  const buildBoard = makeBuildBoard([
    { ...boardAt('understand'), pretriage, reconcile },
    { ...boardAt('execution'), pretriage, reconcile },
    boardAt(null),
  ]);
  const dispatch = makeDispatch();
  await quietDrain(base({ buildBoard, dispatch }));

  // Iteration 0 carries the pretriage + reconcile; every later iteration is emptied.
  assert.deepEqual(dispatch.calls[0].pretriage, pretriage);
  assert.deepEqual(dispatch.calls[0].reconcile, reconcile);
  for (const plan of dispatch.calls.slice(1)) {
    assert.deepEqual(plan.pretriage, []);
    assert.deepEqual(plan.reconcile, []);
  }
});
