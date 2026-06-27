'use strict';

// Regression for WLN-24: the default of `--db` is anchored at the repo ROOT, not the CWD.
//
// Integration proof: ingest run from one CWD and recall run from ANOTHER CWD — both
// WITHOUT `--db` — converge on the SAME kb.db (the root one), so recall finds the chunk that
// ingest wrote. It also ensures NO kb.db is created in the temporary CWDs.
//
// Caution: this test writes to the REAL root kb.db. It uses a sentinel `source`/`ticket`
// and cleans up via deleteBySource (idempotent, WLN-23) in the finally, without touching other data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openMemory } = require('./index.js');

const RECALL = path.join(__dirname, 'recall.mjs');
const INGEST = path.join(__dirname, 'ingest.mjs');

// The real root kb.db = the SAME default that recall.mjs/ingest.mjs resolve.
const ROOT_DB = path.resolve(__dirname, '..', 'kb.db');

// Deterministic offline environment for all subprocesses.
const FAKE_ENV = { ...process.env, KB_FAKE_EMBEDDINGS: '1' };

// Sentinels exclusive to this test (avoid colliding with / cleaning real data).
const SENTINEL_TICKET = 'WLN-24-DBPATH-TEST';
const SENTINEL_SOURCE = 'dim-24-db-path-test-sentinel';
const SENTINEL_TEXT =
  'WLN-24 sentinel: proof that the default of --db is anchored at the repo root, ' +
  'converging recall and ingest on the same kb.db from any CWD.';

function run(script, args, { cwd, input } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    input: input ?? '',
    encoding: 'utf8',
    env: FAKE_ENV,
  });
}

function cleanup(dirs) {
  // Removes what the test wrote in the real kb.db (idempotent) and the temp dirs.
  try {
    const mem = openMemory(ROOT_DB);
    try {
      mem.deleteBySource(SENTINEL_SOURCE);
    } finally {
      mem.close();
    }
  } catch {
    // kb.db may not even exist if ingest failed before creating it — nothing to clean.
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test('default of --db is anchored at the root: ingest (CWD=A) and recall (CWD=B) use the SAME kb.db', () => {
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cwd-a-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cwd-b-'));
  try {
    // Ingest from inside tmpA, WITHOUT --db (uses the default anchored at the root).
    const ing = run(
      INGEST,
      ['--ticket', SENTINEL_TICKET, '--source', SENTINEL_SOURCE, '--fake'],
      { cwd: tmpA, input: SENTINEL_TEXT },
    );
    assert.equal(ing.status, 0, `ingest should exit 0. stderr=${ing.stderr}`);
    const ingOut = JSON.parse(ing.stdout);
    assert.ok(ingOut.chunks > 0, 'ingest wrote at least 1 chunk');

    // Recall from inside tmpB, WITHOUT --db, filtering by the sentinel ticket.
    const rec = run(
      RECALL,
      [SENTINEL_TEXT, '--ticket', SENTINEL_TICKET, '--k', '5', '--fake'],
      { cwd: tmpB },
    );
    assert.equal(rec.status, 0, `recall should exit 0. stderr=${rec.stderr}`);
    const results = JSON.parse(rec.stdout);
    assert.ok(Array.isArray(results), 'recall returns an array');
    assert.ok(
      results.length > 0,
      'recall (CWD=B) found the chunk written by ingest (CWD=A) → same root kb.db',
    );
    assert.ok(
      results.some((r) => r.ticket_id === SENTINEL_TICKET && r.source === SENTINEL_SOURCE),
      'the returned chunk is exactly the ingested sentinel',
    );

    // No stray kb.db in the temporary CWDs (the old relative-default bug).
    assert.ok(!fs.existsSync(path.join(tmpA, 'kb.db')), 'no kb.db created in the ingest CWD');
    assert.ok(!fs.existsSync(path.join(tmpB, 'kb.db')), 'no kb.db created in the recall CWD');
  } finally {
    cleanup([tmpA, tmpB]);
  }
});
