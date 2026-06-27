'use strict';

// Test wrapper for the e2e smoke (WLN-21): runs e2e_smoke.mjs as a real subprocess,
// offline (fake provider) over a temp .db, and asserts BOTH proofs:
//   - recall: the output contains the "## 📚 Relevant memory" block (memory in the prompt);
//   - ingest: the chunk count GREW (new chunk in the KB).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SMOKE = path.join(__dirname, 'e2e_smoke.mjs');
const FAKE_ENV = { ...process.env, KB_FAKE_EMBEDDINGS: '1' };

function run(args) {
  return spawnSync(process.execPath, [SMOKE, ...args], {
    encoding: 'utf8',
    env: FAKE_ENV,
  });
}

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-test-'));
  const db = path.join(dir, 'kb.db');
  try {
    return fn(db);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('e2e_smoke: exit 0, injects the memory block and the KB grows', () => {
  withTempDb((db) => {
    const res = run(['--fake', '--db', db]);
    assert.equal(res.status, 0, `smoke should exit 0. stderr=${res.stderr}`);

    // RECALL proof: the block the driver injects into the prompt appears in the output.
    assert.match(res.stdout, /## 📚 Relevant memory/, 'output contains the memory block');
    assert.match(res.stdout, /proof of RECALL/, 'output marks the recall evidence');

    // INGEST proof: the count went up (before=X after=Y, with after>before).
    const m = res.stdout.match(/before=(\d+)\s+after=(\d+)/);
    assert.ok(m, 'output reports "before=X after=Y"');
    const before = Number(m[1]);
    const after = Number(m[2]);
    assert.ok(after > before, `KB should grow: before=${before} after=${after}`);

    assert.match(res.stdout, /SMOKE OK/, 'smoke concludes with SMOKE OK');
  });
});
