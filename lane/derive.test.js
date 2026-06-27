// Unit tests for the PURE stage derivation (entry pre-triage + rules 1–5 +
// objective kick-back + malformed + cap-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { derive } from './derive.mjs';

const pretriage = (createdAt = '2026-01-01T00:00:00Z') => ({
  header: '## 🎯 Pre-Triage',
  body: `## 🎯 Pre-Triage\n\n**Objective:** ship x\n**Overview:** y`,
  createdAt,
});
const kickback = (createdAt) => ({
  header: '## ⛔ Kick-back: wrong objective',
  body: `## ⛔ Kick-back: wrong objective\n\nplease re-scope`,
  createdAt,
});
const spec = (blockers = '', createdAt = '2026-01-01T00:00:00Z') => ({
  header: '## 🧭 Context Spec',
  body: `## 🧭 Context Spec\n\n**Scope:** x\n**Blockers:** ${blockers}`,
  createdAt,
});
const worklog = (status, createdAt) => ({
  header: '## 🔧 Work Log',
  body: `## 🔧 Work Log\n\n**Branch:** WLN-1\n**Status:** ${status}\n`,
  createdAt,
});
const review = (verdict, createdAt) => ({
  header: '## 🔍 Review',
  body: `## 🔍 Review\n\n**Verdict:** ${verdict}\n**Problems:** none`,
  createdAt,
});

test('entry: no artifact → triage (pre-triage gate)', () => {
  assert.deepEqual(derive([]), { stage: 'triage' });
  assert.deepEqual(derive(undefined), { stage: 'triage' });
});

test('pre-triage only (no Context Spec yet) → understand', () => {
  assert.equal(derive([pretriage()]).stage, 'understand');
});

test('pre-triage + Context Spec (no blockers) → execution', () => {
  const arts = [pretriage('2026-01-01T00:00:00Z'), spec('', '2026-01-02T00:00:00Z')];
  assert.equal(derive(arts).stage, 'execution');
});

test('objective kick-back newer than Pre-Triage → triage (re-run)', () => {
  const arts = [pretriage('2026-01-01T00:00:00Z'), kickback('2026-01-03T00:00:00Z')];
  const r = derive(arts);
  assert.equal(r.stage, 'triage');
  assert.match(r.reason, /kick-back/i);
});

test('re-run pre-triage: new Pre-Triage after a kick-back → understand again', () => {
  const arts = [
    pretriage('2026-01-01T00:00:00Z'),
    kickback('2026-01-02T00:00:00Z'),
    pretriage('2026-01-03T00:00:00Z'),
  ];
  assert.equal(derive(arts).stage, 'understand');
});

test('rule 5: Context Spec with empty Blockers → execution', () => {
  assert.equal(derive([spec('')]).stage, 'execution');
});

test('rule 5: Context Spec with non-empty Blockers → blocked', () => {
  const r = derive([spec('ticket too ambiguous')]);
  assert.equal(r.stage, 'blocked');
  assert.match(r.reason, /blocker/i);
});

// Regression (WLN-58): a prose "None …" sentinel must NOT false-positive into blocked.
// The agent wrote `**Blockers:** None that block implementation. Non-blocking note: …`,
// which the old "any text → blocked" rule mis-read as a real block, stranding the ticket.
test('rule 5: leading none-sentinel Blockers → execution (not blocked)', () => {
  for (const none of [
    'None that block implementation. Non-blocking note: bump the cron interval.',
    'None',
    'N/A',
    'nenhum',
    'nada que bloqueie',
    '-',
    '- none',
  ]) {
    assert.equal(derive([spec(none)]).stage, 'execution', `"${none}" should be execution`);
  }
});

test('rule 5: a real blocker that merely starts with a dash bullet → blocked', () => {
  assert.equal(derive([spec('- WLN-99 must merge first')]).stage, 'blocked');
});

test('rule 3: Work Log SUCCESS → review', () => {
  assert.equal(derive([spec(''), worklog('SUCCESS', '2026-01-02T00:00:00Z')]).stage, 'review');
});

test('rule 4: Work Log FAILED → blocked', () => {
  assert.equal(derive([spec(''), worklog('FAILED', '2026-01-02T00:00:00Z')]).stage, 'blocked');
});

test('rule 1: last Review APPROVED → sign-off', () => {
  const arts = [
    spec('', '2026-01-01T00:00:00Z'),
    worklog('SUCCESS', '2026-01-02T00:00:00Z'),
    review('APPROVED', '2026-01-03T00:00:00Z'),
  ];
  assert.equal(derive(arts).stage, 'sign-off');
});

test('rule 2: Review REJECTED (<3) → execution', () => {
  const arts = [
    spec('', '2026-01-01T00:00:00Z'),
    worklog('SUCCESS', '2026-01-02T00:00:00Z'),
    review('REJECTED', '2026-01-03T00:00:00Z'),
  ];
  assert.equal(derive(arts).stage, 'execution');
});

test('rule 2: 3rd REJECTED → blocked (cap)', () => {
  const arts = [
    review('REJECTED', '2026-01-01T00:00:00Z'),
    review('REJECTED', '2026-01-02T00:00:00Z'),
    review('REJECTED', '2026-01-03T00:00:00Z'),
  ];
  const r = derive(arts);
  assert.equal(r.stage, 'blocked');
  assert.match(r.reason, /cap/i);
});

test('recency: newest artifact decides (Work Log after old Review)', () => {
  const arts = [
    review('REJECTED', '2026-01-01T00:00:00Z'),
    worklog('SUCCESS', '2026-01-05T00:00:00Z'),
  ];
  assert.equal(derive(arts).stage, 'review');
});

test('malformed: Review header but unmatchable Verdict → blocked', () => {
  const bad = {
    header: '## 🔍 Review',
    body: '## 🔍 Review\n\nVerdict: APPROVED (loose, not a field)',
    createdAt: '2026-01-03T00:00:00Z',
  };
  const r = derive([bad]);
  assert.equal(r.stage, 'blocked');
  assert.match(r.reason, /Verdict/);
});

test('malformed: Work Log header but unmatchable Status → blocked', () => {
  const bad = {
    header: '## 🔧 Work Log',
    body: '## 🔧 Work Log\n\nstatus: success somewhere',
    createdAt: '2026-01-02T00:00:00Z',
  };
  assert.equal(derive([bad]).stage, 'blocked');
});

test('malformed: Context Spec header but no Blockers line → blocked', () => {
  const bad = {
    header: '## 🧭 Context Spec',
    body: '## 🧭 Context Spec\n\n**Scope:** x (no blockers line)',
    createdAt: '2026-01-01T00:00:00Z',
  };
  assert.equal(derive([bad]).stage, 'blocked');
});

test('non-station comments are ignored (treated as no artifact → triage)', () => {
  const chatter = { header: 'just a comment', body: 'hello there', createdAt: '2026-01-01T00:00:00Z' };
  assert.equal(derive([chatter]).stage, 'triage');
});
