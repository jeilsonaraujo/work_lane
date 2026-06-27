'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, EMBED_DIM } = require('./db');
const { migrate } = require('./migrate');
const { chunkText } = require('./chunking');
const { FakeEmbeddingProvider, createProvider } = require('./embeddings');
const { openMemory } = require('./index');

// ---------------------------------------------------------------------------
// Migrations: from scratch + idempotence (in-memory).
// ---------------------------------------------------------------------------
test('migrate creates schema and is idempotent (in-memory)', () => {
  const db = openDb(':memory:');
  const first = migrate(db);
  assert.ok(first.includes('001_init'), 'applies 001_init on the 1st run');

  const second = migrate(db);
  assert.deepEqual(second, [], '2nd call reapplies nothing');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('chunks'), 'chunks table exists');
  assert.ok(tables.includes('vec_chunks'), 'virtual table vec_chunks exists');
  assert.ok(tables.includes('schema_migrations'), 'schema_migrations exists');

  // only one migration record
  const count = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  assert.equal(count, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// Migrations idempotent when reopening the connection over a file.
// ---------------------------------------------------------------------------
test('migrate idempotent when reopening file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
  const file = path.join(dir, 'mem.db');
  try {
    const db1 = openDb(file);
    assert.ok(migrate(db1).includes('001_init'));
    db1.close();

    const db2 = openDb(file);
    assert.deepEqual(migrate(db2), [], 'nothing reapplied on reopen');
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Loading the sqlite-vec extension.
// ---------------------------------------------------------------------------
test('sqlite-vec extension loaded (vec_version)', () => {
  const db = openDb(':memory:');
  const v = db.prepare('SELECT vec_version() AS v').get().v;
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0);
  db.close();
});

// ---------------------------------------------------------------------------
// Deterministic chunking.
// ---------------------------------------------------------------------------
test('chunking: short text becomes 1 chunk', () => {
  assert.deepEqual(chunkText('hello world'), ['hello world']);
});

test('chunking: empty/whitespace becomes []', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n  '), []);
});

test('chunking: long text becomes N chunks with overlap and is deterministic', () => {
  const text = 'a'.repeat(1000) + 'b'.repeat(1000);
  const a = chunkText(text, { size: 300, overlap: 50 });
  const b = chunkText(text, { size: 300, overlap: 50 });
  assert.ok(a.length > 1, 'generates several chunks');
  assert.deepEqual(a, b, 'same input → same output');

  // overlap: the end of one chunk reappears at the start of the next.
  const step = 300 - 50;
  assert.equal(a[1], text.slice(step, step + 300));
});

// ---------------------------------------------------------------------------
// Fake provider: determinism + dimension.
// ---------------------------------------------------------------------------
test('FakeEmbeddingProvider: deterministic, dim and normalized', async () => {
  const p = new FakeEmbeddingProvider();
  assert.equal(p.dim, EMBED_DIM);

  const [v1] = await p.embed(['memory context']);
  const [v2] = await p.embed(['memory context']);
  const [v3] = await p.embed(['another distinct text']);

  assert.equal(v1.length, EMBED_DIM);
  assert.deepEqual(Array.from(v1), Array.from(v2), 'same text → same vector');
  assert.notDeepEqual(Array.from(v1), Array.from(v3), 'different texts → different vectors');

  const norm = Math.sqrt(Array.from(v1).reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5, 'normalized vector');
});

test('createProvider default is fake', () => {
  const p = createProvider();
  assert.equal(p.name, 'fake');
  assert.equal(p.dim, EMBED_DIM);
});

// ---------------------------------------------------------------------------
// Ingestion: rows in chunks == vec_chunks == number of chunks; metadata.
// ---------------------------------------------------------------------------
test('ingest persists chunks + vectors + metadata', async () => {
  const mem = openMemory(':memory:');
  const text = 'word '.repeat(200); // ensures multiple chunks
  const { chunks } = await mem.ingest({
    ticketId: 'WLN-12',
    stage: 'execution',
    kind: 'spec',
    source: 'context-spec',
    text,
    chunkOpts: { size: 200, overlap: 40 },
  });
  assert.ok(chunks > 1);

  const nChunks = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  const nVec = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
  assert.equal(nChunks, chunks);
  assert.equal(nVec, chunks);

  const row = mem.db.prepare('SELECT * FROM chunks ORDER BY id LIMIT 1').get();
  assert.equal(row.ticket_id, 'WLN-12');
  assert.equal(row.stage, 'execution');
  assert.equal(row.kind, 'spec');
  assert.equal(row.source, 'context-spec');
  assert.equal(row.chunk_index, 0);
  mem.close();
});

// ---------------------------------------------------------------------------
// Idempotence by `source`: reingest replaces instead of duplicating.
// ---------------------------------------------------------------------------
test('ingest is idempotent by source (reingest does not duplicate, no orphans)', async () => {
  const mem = openMemory(':memory:');
  const text = 'word '.repeat(200); // multiple chunks
  const doc = {
    ticketId: 'WLN-23',
    stage: 'execution',
    kind: 'spec',
    source: 'context-spec',
    text,
    chunkOpts: { size: 200, overlap: 40 },
  };

  const first = await mem.ingest(doc);
  assert.ok(first.chunks > 1, 'first ingestion generates several chunks');

  const second = await mem.ingest(doc); // same source + same text
  assert.equal(second.chunks, first.chunks, 'reingest generates the same number of chunks');

  const nChunks = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  const nVec = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
  assert.equal(nChunks, first.chunks, 'COUNT(chunks) does not grow on reingest');
  assert.equal(nChunks, nVec, 'no orphans: chunks == vec_chunks');
  mem.close();
});

test('ingest with source=null does not deduplicate (count grows)', async () => {
  const mem = openMemory(':memory:');
  const doc = { ticketId: 'WLN-23', source: null, text: 'no source defined' };

  await mem.ingest(doc);
  const afterFirst = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  await mem.ingest(doc);
  const afterSecond = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;

  assert.equal(afterSecond, afterFirst * 2, 'source=null accumulates (no dedup)');
  const nVec = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
  assert.equal(afterSecond, nVec, 'no orphans even with source=null');
  mem.close();
});

test('reingest of one source does not affect other sources nor source IS NULL', async () => {
  const mem = openMemory(':memory:');
  await mem.ingest({ ticketId: 'A', source: 'src-a', text: 'content of source A' });
  await mem.ingest({ ticketId: 'B', source: 'src-b', text: 'content of source B' });
  await mem.ingest({ ticketId: 'N', source: null, text: 'content with no source' });

  const countBy = (where, ...args) =>
    mem.db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE ${where}`).get(...args).n;
  const bBefore = countBy('source = ?', 'src-b');
  const nullBefore = countBy('source IS NULL');

  // reingest only src-a
  await mem.ingest({ ticketId: 'A', source: 'src-a', text: 'content of source A' });

  assert.equal(countBy('source = ?', 'src-a'), 1, 'src-a did not duplicate');
  assert.equal(countBy('source = ?', 'src-b'), bBefore, 'src-b intact');
  assert.equal(countBy('source IS NULL'), nullBefore, 'source IS NULL intact');

  const nChunks = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  const nVec = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
  assert.equal(nChunks, nVec, 'no orphans after isolated reingest');
  mem.close();
});

// ---------------------------------------------------------------------------
// Similarity query: retrieves the expected chunk as top-1, respects k.
// ---------------------------------------------------------------------------
test('query returns top-k by similarity respecting k', async () => {
  const mem = openMemory(':memory:');
  const docs = [
    { ticketId: 'T1', text: 'black cat sleeps on the couch' },
    { ticketId: 'T2', text: 'microservices architecture with queues' },
    { ticketId: 'T3', text: 'carrot cake recipe' },
    { ticketId: 'T4', text: 'sqlite vector database' },
  ];
  await mem.ingestBatch(docs);

  // text identical to T2 → fake produces the SAME vector → distance ~0 → top-1.
  const res = await mem.query('microservices architecture with queues', { k: 2 });
  assert.equal(res.length, 2, 'respects k');
  assert.equal(res[0].ticket_id, 'T2', 'top-1 is the expected chunk');
  mem.close();
});

// ---------------------------------------------------------------------------
// Ranking by ascending distance.
// ---------------------------------------------------------------------------
test('query orders by ascending distance', async () => {
  const mem = openMemory(':memory:');
  await mem.ingestBatch([
    { ticketId: 'A', text: 'alpha beta gamma' },
    { ticketId: 'B', text: 'delta epsilon zeta' },
    { ticketId: 'C', text: 'eta theta iota' },
  ]);
  const res = await mem.query('alpha beta gamma', { k: 3 });
  for (let i = 1; i < res.length; i++) {
    assert.ok(res[i - 1].distance <= res[i].distance, 'non-decreasing distance');
  }
  mem.close();
});

// ---------------------------------------------------------------------------
// Hybrid query: metadata filter excludes out-of-scope chunks.
// ---------------------------------------------------------------------------
test('hybrid query filters by ticket/stage/kind', async () => {
  const mem = openMemory(':memory:');
  await mem.ingestBatch([
    { ticketId: 'T1', stage: 'review', kind: 'note', text: 'same shared content' },
    { ticketId: 'T2', stage: 'execution', kind: 'spec', text: 'same shared content' },
    { ticketId: 'T2', stage: 'review', kind: 'note', text: 'same shared content' },
  ]);

  const byTicket = await mem.query('same shared content', {
    filter: { ticket_id: 'T2' },
    k: 10,
  });
  assert.ok(byTicket.length > 0);
  assert.ok(byTicket.every((r) => r.ticket_id === 'T2'), 'only T2');

  const byStageKind = await mem.query('same shared content', {
    filter: { ticket_id: 'T2', stage: 'execution', kind: 'spec' },
    k: 10,
  });
  assert.equal(byStageKind.length, 1, 'only the T2/execution/spec chunk');
  assert.equal(byStageKind[0].stage, 'execution');
  assert.equal(byStageKind[0].kind, 'spec');
  mem.close();
});

// ---------------------------------------------------------------------------
// fetch: direct retrieval by metadata (no KNN) brings the whole artifact.
// ---------------------------------------------------------------------------
test('fetch brings the whole artifact ordered by source, chunk_index', async () => {
  const mem = openMemory(':memory:');
  // multi-chunk doc with fixed source → several sequential chunk_index.
  const text = 'word '.repeat(300);
  const { chunks } = await mem.ingest({
    ticketId: 'WLN-29',
    stage: 'understand',
    kind: 'spec',
    source: 'context-spec',
    text,
    chunkOpts: { size: 200, overlap: 40 },
  });
  assert.ok(chunks > 2, 'generates several chunks');
  // noise from another ticket — must not appear in the filtered fetch.
  await mem.ingest({ ticketId: 'OTHER', kind: 'spec', source: 'noise', text: 'noise' });

  const res = mem.fetch({ ticket_id: 'WLN-29', kind: 'spec' });
  assert.equal(res.length, chunks, 'brings ALL chunks of the artifact');
  assert.ok(res.every((r) => r.ticket_id === 'WLN-29'), 'only the target ticket');
  // ordered by chunk_index asc, covering 0,1,2,...
  for (let i = 0; i < res.length; i++) {
    assert.equal(res[i].chunk_index, i, `chunk_index ${i} in order`);
  }
  // no embedding/distance — shape compatible with query.
  assert.ok(res.every((r) => r.distance === null), 'distance is null');
  assert.ok('body' in res[0] && 'source' in res[0], 'keeps the shape keys');

  // optional LIMIT via k.
  const limited = mem.fetch({ ticket_id: 'WLN-29', kind: 'spec' }, { k: 2 });
  assert.equal(limited.length, 2, 'k applies LIMIT');
  mem.close();
});

// ---------------------------------------------------------------------------
// Adaptive knnK: a selective filter does not empty the result when there is a match.
// ---------------------------------------------------------------------------
test('filtered KNN does not come back empty with a match (adaptive knnK)', async () => {
  const mem = openMemory(':memory:');
  // 1 target chunk + lots of noise from other tickets (more than 4*k neighbors),
  // such that the target would NOT be in the 4*k window if it were not widened.
  await mem.ingest({ ticketId: 'TARGET', kind: 'spec', text: 'distinct target document' });
  for (let i = 0; i < 50; i++) {
    await mem.ingest({ ticketId: `NOISE-${i}`, kind: 'spec', text: `noise number ${i}` });
  }

  // query unrelated to the target + selective filter on the target ticket → still finds it.
  const hit = await mem.query('any unrelated query', {
    filter: { ticket_id: 'TARGET' },
    k: 2,
  });
  assert.ok(hit.length > 0, 'selective filter with a match does not return []');
  assert.ok(hit.every((r) => r.ticket_id === 'TARGET'), 'only the target ticket');

  // nonexistent match → [].
  const miss = await mem.query('any query', {
    filter: { ticket_id: 'DOES-NOT-EXIST' },
    k: 2,
  });
  assert.deepEqual(miss, [], 'nonexistent ticket → []');
  mem.close();
});

// ---------------------------------------------------------------------------
// Isolation: the suite does not load transformers (no network).
// ---------------------------------------------------------------------------
test('transformers.js was NOT loaded by the suite', () => {
  const loaded = Object.keys(require.cache).some((p) =>
    p.includes(path.join('@huggingface', 'transformers'))
  );
  assert.equal(loaded, false, 'the real provider must not be imported in the tests');
});
