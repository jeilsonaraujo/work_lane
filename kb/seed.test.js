'use strict';

// e2e smoke of the seed.mjs CLI + direct test of deleteBySource (WLN-18).
//
// Invokes seed.mjs/recall.mjs as real subprocesses (like the driver would) and forces
// the fake provider (offline) via --fake + KB_FAKE_EMBEDDINGS, over a temp .db.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openMemory } = require('./index.js');

const SEED = path.join(__dirname, 'seed.mjs');
const RECALL = path.join(__dirname, 'recall.mjs');

// Deterministic offline environment for all subprocesses.
const FAKE_ENV = { ...process.env, KB_FAKE_EMBEDDINGS: '1' };

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: FAKE_ENV,
  });
}

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-seed-'));
  const db = path.join(dir, 'kb.db');
  try {
    return fn(db);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Counts rows in chunks and vec_chunks by opening the .db directly.
function counts(db) {
  const mem = openMemory(db);
  try {
    const chunks = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    const vec = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
    return { chunks, vec };
  } finally {
    mem.close();
  }
}

test('seed 1x: exit 0, parseable JSON, total>0 and chunks persisted', () => {
  withTempDb((db) => {
    const res = run(SEED, ['--fake', '--db', db]);
    assert.equal(res.status, 0, `seed should exit 0. stderr=${res.stderr}`);

    let out;
    assert.doesNotThrow(() => {
      out = JSON.parse(res.stdout);
    }, 'seed stdout must be parseable JSON');

    assert.ok(out.total > 0, 'total > 0');
    assert.ok(Array.isArray(out.seeded), 'seeded is an array');
    assert.ok(out.seeded.length > 0, 'at least one seeded doc');

    const { chunks } = counts(db);
    assert.equal(chunks, out.total, 'persisted chunks === reported total');
  });
});

test('seed 2x: stable count (idempotence) and no orphans', () => {
  withTempDb((db) => {
    const first = run(SEED, ['--fake', '--db', db]);
    assert.equal(first.status, 0, `1st seed should exit 0. stderr=${first.stderr}`);
    const after1 = counts(db);

    const second = run(SEED, ['--fake', '--db', db]);
    assert.equal(second.status, 0, `2nd seed should exit 0. stderr=${second.stderr}`);
    const after2 = counts(db);

    assert.equal(after2.chunks, after1.chunks, 'seed 2x does not duplicate chunks');
    assert.equal(after2.chunks, after2.vec, 'COUNT(chunks) === COUNT(vec_chunks) (no orphans)');
  });
});

test('recall --kind doc finds the doc seeded by seed', () => {
  withTempDb((db) => {
    const seed = run(SEED, ['--fake', '--db', db]);
    assert.equal(seed.status, 0, `seed should exit 0. stderr=${seed.stderr}`);

    // "Loop Engineering" is a term present in CLAUDE.md.
    const rec = run(RECALL, ['Loop Engineering task pipeline', '--kind', 'doc', '--k', '200', '--fake', '--db', db]);
    assert.equal(rec.status, 0, `recall should exit 0. stderr=${rec.stderr}`);

    const results = JSON.parse(rec.stdout);
    assert.ok(Array.isArray(results), 'recall returns an array');
    assert.ok(results.length > 0, 'recall returns at least 1 result');
    for (const r of results) {
      assert.equal(r.kind, 'doc', 'all results are kind=doc');
    }
    const sources = new Set(results.map((r) => r.source));
    assert.ok(sources.has('CLAUDE.md'), 'CLAUDE.md is among the returned sources');
  });
});

test('seed also ingests source code (kind=code): kb/index.js + at least one from .claude/', () => {
  withTempDb((db) => {
    const res = run(SEED, ['--fake', '--db', db]);
    assert.equal(res.status, 0, `seed should exit 0. stderr=${res.stderr}`);

    const out = JSON.parse(res.stdout);
    const bySource = new Map(out.seeded.map((s) => [s.source, s]));

    assert.ok(bySource.has('kb/index.js'), 'kb/index.js is among the seeded sources');
    assert.equal(bySource.get('kb/index.js').kind, 'code', 'kb/index.js enters as kind=code');
    assert.ok(bySource.get('kb/index.js').chunks > 0, 'kb/index.js generated at least 1 chunk');

    assert.ok(bySource.has('kb/seed.mjs'), 'kb/seed.mjs is among the seeded sources');
    assert.equal(bySource.get('kb/seed.mjs').kind, 'code', 'kb/seed.mjs enters as kind=code');

    const claudeCode = out.seeded.filter(
      (s) => s.kind === 'code' && s.source.startsWith('.claude/')
    );
    assert.ok(claudeCode.length > 0, 'at least one prompt from .claude/ seeded as code');
    assert.ok(
      claudeCode.some((s) => s.source === '.claude/skills/lane/SKILL.md'),
      '.claude/skills/lane/SKILL.md is among the code sources'
    );
  });
});

test('recall --kind code by a real symbol finds kb/index.js', () => {
  withTempDb((db) => {
    const seed = run(SEED, ['--fake', '--db', db]);
    assert.equal(seed.status, 0, `seed should exit 0. stderr=${seed.stderr}`);

    const rec = run(RECALL, ['openMemory ingest', '--kind', 'code', '--k', '200', '--fake', '--db', db]);
    assert.equal(rec.status, 0, `recall should exit 0. stderr=${rec.stderr}`);

    const results = JSON.parse(rec.stdout);
    assert.ok(Array.isArray(results), 'recall returns an array');
    assert.ok(results.length > 0, 'recall returns at least 1 result');
    for (const r of results) {
      assert.equal(r.kind, 'code', 'all results are kind=code');
    }
    const sources = new Set(results.map((r) => r.source));
    assert.ok(sources.has('kb/index.js'), 'kb/index.js is among the returned sources');
  });
});

test('seed excludes node_modules, *.db, *.test.js and .claude/worktrees/**', () => {
  withTempDb((db) => {
    const res = run(SEED, ['--fake', '--db', db]);
    assert.equal(res.status, 0, `seed should exit 0. stderr=${res.stderr}`);

    const out = JSON.parse(res.stdout);
    for (const { source } of out.seeded) {
      const segments = source.split('/');
      assert.ok(!segments.includes('node_modules'), `source not under node_modules: ${source}`);
      assert.ok(!segments.includes('.git'), `source not under .git: ${source}`);
      assert.ok(!segments.includes('worktrees'), `source not under worktrees: ${source}`);
      assert.ok(!source.endsWith('.db'), `source is not *.db: ${source}`);
      assert.ok(!source.endsWith('.test.js'), `source is not *.test.js: ${source}`);
    }
  });
});

test('deleteBySource removes only the target source, leaving no orphans', async () => {
  withTempDb(async (db) => {
    const mem = openMemory(db);
    try {
      await mem.ingest({ ticketId: 'REPO', kind: 'doc', source: 'a.md', text: 'alpha one two three four' });
      await mem.ingest({ ticketId: 'REPO', kind: 'doc', source: 'b.md', text: 'beta five six seven eight' });

      const before = {
        chunks: mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n,
        vec: mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n,
      };
      assert.ok(before.chunks > 0, 'there are chunks before the delete');
      assert.equal(before.chunks, before.vec, 'paired before the delete');

      const removed = mem.deleteBySource('a.md');
      assert.ok(removed > 0, 'deleteBySource reports removed rows');

      const aLeft = mem.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE source = 'a.md'").get().n;
      const bLeft = mem.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE source = 'b.md'").get().n;
      const vecLeft = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
      const chunksLeft = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;

      assert.equal(aLeft, 0, 'source a.md fully removed');
      assert.ok(bLeft > 0, 'source b.md intact');
      assert.equal(chunksLeft, vecLeft, 'no orphans after the delete');
      assert.equal(removed, before.chunks - chunksLeft, 'removed matches the count difference');
    } finally {
      mem.close();
    }
  });
});
