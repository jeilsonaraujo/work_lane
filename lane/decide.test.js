// Unit tests for the PURE next-action decision (WIP=1 + auto-sequence ordering).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, eligibleTodos, orderTodos, anchorParent } from './decide.mjs';

const t = (number, over = {}) => ({
  id: `iss-${number}`,
  identifier: `WLN-${number}`,
  number,
  priority: 0,
  parent: null,
  blockedBy: [],
  ...over,
});

test('WIP=1: active understand ticket → understand action (no pull)', () => {
  const board = {
    inProgress: { ticket: t(10), stage: 'understand' },
    todos: [t(20)],
    integrated: [],
  };
  assert.deepEqual(decide(board), { type: 'understand', ticket: t(10) });
});

test('active execution/review map to their actions', () => {
  assert.equal(decide({ inProgress: { ticket: t(1), stage: 'execution' }, todos: [] }).type, 'execution');
  assert.equal(decide({ inProgress: { ticket: t(1), stage: 'review' }, todos: [] }).type, 'review');
});

test('sign-off → merge action', () => {
  assert.equal(decide({ inProgress: { ticket: t(1), stage: 'sign-off' }, todos: [] }).type, 'merge');
});

test('blocked in-progress does NOT occupy the slot → still pulls a Todo', () => {
  const board = {
    inProgress: { ticket: t(5), stage: 'blocked' },
    todos: [t(20)],
    integrated: [],
  };
  const a = decide(board);
  assert.equal(a.type, 'pull');
  assert.equal(a.ticket.number, 20);
});

test('no active + no eligible Todo → idle', () => {
  const board = {
    inProgress: null,
    todos: [t(20, { blockedBy: [{ state: 'In Progress' }] })],
    integrated: [],
  };
  assert.deepEqual(decide(board), { type: 'idle' });
});

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

test('full decide pulls the top-ordered eligible Todo', () => {
  const board = {
    inProgress: null,
    todos: [
      t(30, { priority: 3, parent: 'epic-A', blockedBy: [{ state: 'Done' }] }),
      t(40, { priority: 1, parent: 'epic-A', blockedBy: [] }),
    ],
    integrated: [{ id: 'x', parent: 'epic-A', updatedAt: '2026-02-01T00:00:00Z' }],
  };
  const a = decide(board);
  assert.equal(a.type, 'pull');
  assert.equal(a.ticket.number, 40);
});
