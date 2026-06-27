// Unit tests for the PURE next-action decision: the WIP=1 active slot + the
// pre-triage phase (cap-3, idempotency by artifact, Triage = pure signal) +
// the auto-sequence ordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, eligibleTodos, orderTodos, anchorParent, PRETRIAGE_CAP } from './decide.mjs';

const t = (number, over = {}) => ({
  id: `iss-${number}`,
  identifier: `WLN-${number}`,
  number,
  priority: 0,
  parent: null,
  blockedBy: [],
  ...over,
});

// --- WIP=1 active slot --------------------------------------------------------

test('WIP=1: active understand ticket → active.understand (no pretriage when no Todos)', () => {
  const board = {
    inProgress: { ticket: t(10), stage: 'understand' },
    todos: [],
    triage: [],
    integrated: [],
  };
  const plan = decide(board);
  assert.deepEqual(plan.active, { type: 'understand', ticket: t(10) });
  assert.deepEqual(plan.pretriage, []);
  assert.deepEqual(plan.reconcile, []);
});

test('active execution/review/sign-off map to their active actions', () => {
  assert.equal(decide({ inProgress: { ticket: t(1), stage: 'execution' } }).active.type, 'execution');
  assert.equal(decide({ inProgress: { ticket: t(1), stage: 'review' } }).active.type, 'review');
  assert.equal(decide({ inProgress: { ticket: t(1), stage: 'sign-off' } }).active.type, 'merge');
});

test('no active In-Progress ticket → active idle', () => {
  assert.deepEqual(decide({ inProgress: null }).active, { type: 'idle' });
});

test('blocked in-progress does NOT occupy the slot → active idle', () => {
  const board = { inProgress: { ticket: t(5), stage: 'blocked' }, todos: [], triage: [], integrated: [] };
  assert.deepEqual(decide(board).active, { type: 'idle' });
});

// --- Pure helpers (unchanged) -------------------------------------------------

test('eligibility: a Todo is eligible only if all blockedBy are integrated', () => {
  const todos = [
    t(1, { blockedBy: [{ state: 'To Review' }, { state: 'Done' }] }), // eligible
    t(2, { blockedBy: [{ state: 'In Progress' }] }), // not eligible
    t(3, { blockedBy: [] }), // eligible
  ];
  const elig = eligibleTodos(todos).map((x) => x.number);
  assert.deepEqual(elig.sort(), [1, 3]);
});

test('anchorParent = parent of max-updatedAt integrated ticket', () => {
  const integrated = [
    { id: 'a', parent: 'epic-1', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'b', parent: 'epic-2', updatedAt: '2026-02-01T00:00:00Z' },
  ];
  assert.equal(anchorParent(integrated), 'epic-2');
  assert.equal(anchorParent([]), null);
});

test('ordering: epic continuity beats priority and number', () => {
  const integrated = [{ id: 'x', parent: 'epic-A', updatedAt: '2026-02-01T00:00:00Z' }];
  const todos = [
    t(30, { priority: 1, parent: 'epic-B' }), // urgent but different epic
    t(40, { priority: 4, parent: 'epic-A' }), // low priority but same epic as anchor
  ];
  const ordered = orderTodos(todos, integrated).map((x) => x.number);
  assert.deepEqual(ordered, [40, 30]);
});

test('ordering: priority then lowest number when no anchor', () => {
  const todos = [
    t(30, { priority: 3 }), // Medium
    t(31, { priority: 1 }), // Urgent
    t(20, { priority: 1 }), // Urgent, lower number
  ];
  const ordered = orderTodos(todos, []).map((x) => x.number);
  assert.deepEqual(ordered, [20, 31, 30]);
});

// --- Pre-triage phase (the 7 spec cases) --------------------------------------

// (1) A Todo WITHOUT a Pre-Triage → pretriage from:'Todo' (run the triager in place).
test('(1) eligible Todo without a Pre-Triage → pretriage from Todo', () => {
  const board = {
    inProgress: null,
    todos: [t(60, { blockedBy: [] })],
    triage: [],
    integrated: [],
  };
  const plan = decide(board);
  assert.equal(plan.pretriage.length, 1);
  assert.deepEqual(plan.pretriage[0], { type: 'pretriage', ticket: board.todos[0], from: 'Todo' });
  assert.deepEqual(plan.reconcile, []);
});

// (2) A Todo that ALREADY has a Pre-Triage → move-to-triage (NOT re-triaged).
test('(2) Todo WITH a Pre-Triage → move-to-triage, not pretriage', () => {
  const todo = t(61, { hasPretriage: true });
  const board = { inProgress: null, todos: [todo], triage: [], integrated: [] };
  const plan = decide(board);
  assert.deepEqual(plan.reconcile, [{ type: 'move-to-triage', ticket: todo }]);
  assert.equal(plan.pretriage.length, 0);
});

// (3) A legacy empty Triage ticket (old model) → pretriage from:'Triage' (in place).
test('(3) legacy empty Triage ticket → pretriage from Triage (in place)', () => {
  const legacy = { ...t(70), hasPretriage: false };
  const board = { inProgress: null, todos: [], triage: [legacy], integrated: [] };
  const plan = decide(board);
  assert.equal(plan.pretriage.length, 1);
  assert.equal(plan.pretriage[0].type, 'pretriage');
  assert.equal(plan.pretriage[0].from, 'Triage');
  assert.equal(plan.pretriage[0].ticket.number, 70);
});

// (4) A Triage ticket WITH a Pre-Triage → pure HOLD, no action at all.
test('(4) Triage ticket with a Pre-Triage → HOLD (no pretriage, no reconcile)', () => {
  const hold = { ...t(71), hasPretriage: true };
  const board = { inProgress: null, todos: [], triage: [hold], integrated: [] };
  const plan = decide(board);
  assert.deepEqual(plan.pretriage, []);
  assert.deepEqual(plan.reconcile, []);
});

// (5) ≥4 eligible Todos w/o Pre-Triage → exactly PRETRIAGE_CAP pretriages, ordered.
test('(5) more eligible Todos than the cap → exactly PRETRIAGE_CAP pretriages, ordered', () => {
  const board = {
    inProgress: null,
    todos: [
      t(30, { priority: 3 }),
      t(31, { priority: 1 }),
      t(20, { priority: 1 }),
      t(40, { priority: 4 }),
    ],
    triage: [],
    integrated: [],
  };
  const plan = decide(board);
  assert.equal(PRETRIAGE_CAP, 3);
  assert.equal(plan.pretriage.length, 3);
  // ordered: priority Urgent(20,31) then Medium(30); Low(40) dropped by the cap.
  assert.deepEqual(plan.pretriage.map((a) => a.ticket.number), [20, 31, 30]);
  assert.ok(plan.pretriage.every((a) => a.from === 'Todo'));
});

// (6) The cap is independent of WIP=1: an active execution AND up to 3 pretriages.
test('(6) active execution + 3 Todos → active.execution AND 3 pretriages in one plan', () => {
  const board = {
    inProgress: { ticket: t(10), stage: 'execution' },
    todos: [t(20), t(21), t(22)],
    triage: [],
    integrated: [],
  };
  const plan = decide(board);
  assert.equal(plan.active.type, 'execution');
  assert.equal(plan.active.ticket.number, 10);
  assert.equal(plan.pretriage.length, 3);
});

// (7) Tickets sitting in Triage (holds) do NOT block pre-triaging Todos.
test('(7) N Triage holds do not block pre-triaging Todos', () => {
  const board = {
    inProgress: null,
    todos: [t(80), t(81)],
    triage: [
      { ...t(90), hasPretriage: true },
      { ...t(91), hasPretriage: true },
      { ...t(92), hasPretriage: true },
    ],
    integrated: [],
  };
  const plan = decide(board);
  assert.deepEqual(plan.reconcile, []);
  assert.equal(plan.pretriage.length, 2);
  assert.deepEqual(plan.pretriage.map((a) => a.ticket.number).sort(), [80, 81]);
});

// --- Composite ordering across Todo + legacy Triage candidates ----------------

test('pretriage candidates from Todo and legacy Triage are ordered together by orderTodos', () => {
  const board = {
    inProgress: null,
    todos: [t(60, { priority: 1, parent: 'epic-B' })],
    triage: [{ ...t(62, { priority: 4, parent: 'epic-A' }), hasPretriage: false }],
    integrated: [{ id: 'x', parent: 'epic-A', updatedAt: '2026-02-01T00:00:00Z' }],
  };
  const plan = decide(board);
  // epic continuity (anchor epic-A) wins → the legacy Triage ticket (62) comes first.
  assert.deepEqual(plan.pretriage.map((a) => [a.ticket.number, a.from]), [
    [62, 'Triage'],
    [60, 'Todo'],
  ]);
});

test('no eligible candidates anywhere → empty pretriage & reconcile', () => {
  const board = {
    inProgress: null,
    todos: [t(20, { blockedBy: [{ state: 'In Progress' }] })],
    triage: [],
    integrated: [],
  };
  const plan = decide(board);
  assert.deepEqual(plan.pretriage, []);
  assert.deepEqual(plan.reconcile, []);
  assert.deepEqual(plan.active, { type: 'idle' });
});
