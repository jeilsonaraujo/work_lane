'use strict';

// e2e smoke of the recall.mjs / ingest.mjs CLIs (WLN-17).
//
// Invokes the scripts as real subprocesses (like the driver would) and forces the
// fake provider (offline) via --fake + KB_FAKE_EMBEDDINGS, over a temp .db.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RECALL = path.join(__dirname, 'recall.mjs');
const INGEST = path.join(__dirname, 'ingest.mjs');

// Deterministic offline environment for all subprocesses.
const FAKE_ENV = { ...process.env, KB_FAKE_EMBEDDINGS: '1' };

function run(script, args, { input } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    input: input ?? '',
    encoding: 'utf8',
    env: FAKE_ENV,
  });
}

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cli-'));
  const db = path.join(dir, 'kb.db');
  try {
    return fn(db);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ingest via stdin produces chunks>0 and ids.length === chunks; output is JSON', () => {
  withTempDb((db) => {
    const res = run(INGEST, ['--ticket', 'WLN-17', '--kind', 'doc', '--fake', '--db', db], {
      input: 'The memory uses sqlite-vec over better-sqlite3 with local-first embeddings.',
    });
    assert.equal(res.status, 0, `ingest should exit 0. stderr=${res.stderr}`);

    let out;
    assert.doesNotThrow(() => {
      out = JSON.parse(res.stdout);
    }, 'ingest stdout must be parseable JSON');

    assert.ok(out.chunks > 0, 'chunks > 0');
    assert.equal(out.ids.length, out.chunks, 'ids.length === chunks');
  });
});

test('recall after ingest returns top-1 = ingested text; output is JSON', () => {
  withTempDb((db) => {
    const text = 'Chunking is deterministic by size and overlap.';
    const ing = run(INGEST, ['--ticket', 'WLN-17', '--fake', '--db', db], { input: text });
    assert.equal(ing.status, 0, `ingest should exit 0. stderr=${ing.stderr}`);

    const rec = run(RECALL, [text, '--k', '3', '--fake', '--db', db]);
    assert.equal(rec.status, 0, `recall should exit 0. stderr=${rec.stderr}`);

    let results;
    assert.doesNotThrow(() => {
      results = JSON.parse(rec.stdout);
    }, 'recall stdout must be parseable JSON');

    assert.ok(Array.isArray(results), 'recall returns an array');
    assert.ok(results.length > 0, 'recall returns at least 1 result');
    assert.equal(results[0].body, text, 'top-1 is the ingested text');
    assert.equal(results[0].ticket_id, 'WLN-17', 'ticket_id metadata present');
  });
});

test('recall with --ticket filters by ticket_id', () => {
  withTempDb((db) => {
    run(INGEST, ['--ticket', 'AAA-1', '--fake', '--db', db], { input: 'alpha one two three' });
    run(INGEST, ['--ticket', 'BBB-2', '--fake', '--db', db], { input: 'beta four five six' });

    const rec = run(RECALL, ['any query', '--ticket', 'AAA-1', '--fake', '--db', db]);
    assert.equal(rec.status, 0, `recall should exit 0. stderr=${rec.stderr}`);
    const results = JSON.parse(rec.stdout);
    assert.ok(results.length > 0, 'there are results for AAA-1');
    for (const r of results) {
      assert.equal(r.ticket_id, 'AAA-1', 'all results are from the filtered ticket');
    }
  });
});

test('ingest with empty stdin returns {chunks:0, ids:[]} (not an error)', () => {
  withTempDb((db) => {
    const res = run(INGEST, ['--ticket', 'WLN-17', '--fake', '--db', db], { input: '' });
    assert.equal(res.status, 0, `empty ingest should exit 0. stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.chunks, 0);
    assert.deepEqual(out.ids, []);
  });
});

test('ingest without --ticket exits with code != 0 and non-empty stderr', () => {
  const res = run(INGEST, ['--fake'], { input: 'any text' });
  assert.notEqual(res.status, 0, 'must fail without --ticket');
  assert.ok(res.stderr.trim().length > 0, 'non-empty stderr');
  assert.equal(res.stdout.trim(), '', 'no JSON in stdout on error');
});

test('recall without positional query exits with code != 0 and non-empty stderr', () => {
  withTempDb((db) => {
    const res = run(RECALL, ['--fake', '--db', db]);
    assert.notEqual(res.status, 0, 'must fail without query');
    assert.ok(res.stderr.trim().length > 0, 'non-empty stderr');
  });
});

test('recall --exact (without --k) returns the WHOLE artifact even with >5 chunks', () => {
  withTempDb((db) => {
    // Text long enough for > 5 chunks (size=512/step=448): ~5.5k chars ⇒ ~13 chunks.
    // Crucial: if the CLI applied the old default --k=5, this would truncate at 5 and the
    // assert results.length === chunks would fail — exactly the rejected bug.
    const spec = 'acceptance criterion of the hybrid recall '.repeat(150);
    const ing = run(
      INGEST,
      ['--ticket', 'WLN-29', '--kind', 'spec', '--source', 'spec-1', '--fake', '--db', db],
      { input: spec }
    );
    assert.equal(ing.status, 0, `ingest should exit 0. stderr=${ing.stderr}`);
    const ingOut = JSON.parse(ing.stdout);
    assert.ok(ingOut.chunks > 5, `spec needs >5 chunks to prove the fix (got ${ingOut.chunks})`);

    // --exact WITHOUT --k and WITHOUT positional query → status 0 + full JSON array.
    const rec = run(RECALL, ['--exact', '--ticket', 'WLN-29', '--kind', 'spec', '--fake', '--db', db]);
    assert.equal(rec.status, 0, `recall --exact should exit 0. stderr=${rec.stderr}`);
    const results = JSON.parse(rec.stdout);
    assert.ok(Array.isArray(results), 'returns an array');
    assert.equal(results.length, ingOut.chunks, 'brings ALL chunks of the spec (no LIMIT 5)');
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].chunk_index, i, 'ordered by chunk_index');
      assert.equal(results[i].ticket_id, 'WLN-29', 'only the target ticket');
      assert.equal(results[i].distance, null, 'no distance (direct fetch)');
    }
  });
});

test('recall --exact --k N applies the explicit limit (override still holds)', () => {
  withTempDb((db) => {
    const spec = 'acceptance criterion of the hybrid recall '.repeat(150);
    const ing = run(
      INGEST,
      ['--ticket', 'WLN-29', '--kind', 'spec', '--source', 'spec-1', '--fake', '--db', db],
      { input: spec }
    );
    assert.equal(ing.status, 0, `ingest should exit 0. stderr=${ing.stderr}`);
    const ingOut = JSON.parse(ing.stdout);
    assert.ok(ingOut.chunks > 3, 'needs more chunks than the limit to prove the cut');

    const rec = run(
      RECALL,
      ['--exact', '--ticket', 'WLN-29', '--kind', 'spec', '--k', '3', '--fake', '--db', db]
    );
    assert.equal(rec.status, 0, `recall --exact --k 3 should exit 0. stderr=${rec.stderr}`);
    const results = JSON.parse(rec.stdout);
    assert.equal(results.length, 3, '--k 3 limits the fetch to 3 chunks');
  });
});
