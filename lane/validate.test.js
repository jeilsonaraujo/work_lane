// Unit tests for the PURE pre-post format validation (d.0.6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, validateTriage, validateUnderstand, validateExecution, validateReview } from './validate.mjs';

test('triage: valid Pre-Triage with header passes', () => {
  const body = '## 🎯 Pre-Triage\n\n**Objective:** ship x\n**Overview:** y';
  assert.deepEqual(validateTriage(body), { ok: true });
});

test('triage: missing header fails', () => {
  const r = validateTriage('**Objective:** ship x (no header)');
  assert.equal(r.ok, false);
  assert.match(r.error, /header/);
});

test('understand: valid spec with empty Blockers passes', () => {
  const body = '## 🧭 Context Spec\n\n**Scope:** x\n**Blockers:** ';
  assert.deepEqual(validateUnderstand(body), { ok: true });
});

test('understand: missing header fails', () => {
  const r = validateUnderstand('**Blockers:** ');
  assert.equal(r.ok, false);
  assert.match(r.error, /header/);
});

test('understand: missing Blockers line fails', () => {
  const r = validateUnderstand('## 🧭 Context Spec\n\n**Scope:** x');
  assert.equal(r.ok, false);
  assert.match(r.error, /Blockers/);
});

test('execution: valid work log with exactly one Status passes', () => {
  const body = '## 🔧 Work Log\n\n**Status:** SUCCESS\n';
  assert.deepEqual(validateExecution(body), { ok: true });
});

test('execution: missing Status fails', () => {
  const r = validateExecution('## 🔧 Work Log\n\nno status here');
  assert.equal(r.ok, false);
  assert.match(r.error, /Status/);
});

test('execution: more than one Status fails', () => {
  const body = '## 🔧 Work Log\n\n**Status:** SUCCESS\n**Status:** FAILED\n';
  const r = validateExecution(body);
  assert.equal(r.ok, false);
  assert.match(r.error, /more than one/);
});

test('review: valid review with exactly one Verdict passes', () => {
  const body = '## 🔍 Review\n\n**Verdict:** APPROVED\n';
  assert.deepEqual(validateReview(body), { ok: true });
});

test('review: missing Verdict fails', () => {
  const r = validateReview('## 🔍 Review\n\nI approve this');
  assert.equal(r.ok, false);
  assert.match(r.error, /Verdict/);
});

test('review: more than one Verdict fails', () => {
  const body = '## 🔍 Review\n\n**Verdict:** APPROVED\n**Verdict:** REJECTED\n';
  const r = validateReview(body);
  assert.equal(r.ok, false);
  assert.match(r.error, /more than one/);
});

test('validate dispatches by station and rejects unknown', () => {
  assert.equal(validate('triage', '## 🎯 Pre-Triage\n**Objective:** x').ok, true);
  assert.equal(validate('understand', '## 🧭 Context Spec\n**Blockers:** ').ok, true);
  assert.equal(validate('bogus', 'x').ok, false);
});
