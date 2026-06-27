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
// Migrations: do zero + idempotência (in-memory).
// ---------------------------------------------------------------------------
test('migrate cria schema e é idempotente (in-memory)', () => {
  const db = openDb(':memory:');
  const first = migrate(db);
  assert.ok(first.includes('001_init'), 'aplica 001_init na 1ª vez');

  const second = migrate(db);
  assert.deepEqual(second, [], '2ª chamada não reaplica nada');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('chunks'), 'tabela chunks existe');
  assert.ok(tables.includes('vec_chunks'), 'tabela virtual vec_chunks existe');
  assert.ok(tables.includes('schema_migrations'), 'schema_migrations existe');

  // só um registro de migration
  const count = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  assert.equal(count, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// Migrations idempotentes ao reabrir conexão sobre arquivo.
// ---------------------------------------------------------------------------
test('migrate idempotente reabrindo arquivo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
  const file = path.join(dir, 'mem.db');
  try {
    const db1 = openDb(file);
    assert.ok(migrate(db1).includes('001_init'));
    db1.close();

    const db2 = openDb(file);
    assert.deepEqual(migrate(db2), [], 'nada reaplicado na reabertura');
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Carga da extensão sqlite-vec.
// ---------------------------------------------------------------------------
test('extensão sqlite-vec carregada (vec_version)', () => {
  const db = openDb(':memory:');
  const v = db.prepare('SELECT vec_version() AS v').get().v;
  assert.equal(typeof v, 'string');
  assert.ok(v.length > 0);
  db.close();
});

// ---------------------------------------------------------------------------
// Chunking determinístico.
// ---------------------------------------------------------------------------
test('chunking: texto curto vira 1 chunk', () => {
  assert.deepEqual(chunkText('oi mundo'), ['oi mundo']);
});

test('chunking: vazio/whitespace vira []', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n  '), []);
});

test('chunking: texto longo vira N chunks com overlap e é determinístico', () => {
  const text = 'a'.repeat(1000) + 'b'.repeat(1000);
  const a = chunkText(text, { size: 300, overlap: 50 });
  const b = chunkText(text, { size: 300, overlap: 50 });
  assert.ok(a.length > 1, 'gera vários chunks');
  assert.deepEqual(a, b, 'mesmo input → mesmo output');

  // overlap: o fim de um chunk reaparece no início do próximo.
  const step = 300 - 50;
  assert.equal(a[1], text.slice(step, step + 300));
});

// ---------------------------------------------------------------------------
// Provider fake: determinismo + dimensão.
// ---------------------------------------------------------------------------
test('FakeEmbeddingProvider: determinístico, dim e normalizado', async () => {
  const p = new FakeEmbeddingProvider();
  assert.equal(p.dim, EMBED_DIM);

  const [v1] = await p.embed(['contexto da memória']);
  const [v2] = await p.embed(['contexto da memória']);
  const [v3] = await p.embed(['outro texto distinto']);

  assert.equal(v1.length, EMBED_DIM);
  assert.deepEqual(Array.from(v1), Array.from(v2), 'mesmo texto → mesmo vetor');
  assert.notDeepEqual(Array.from(v1), Array.from(v3), 'textos diferentes → vetores diferentes');

  const norm = Math.sqrt(Array.from(v1).reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5, 'vetor normalizado');
});

test('createProvider default é fake', () => {
  const p = createProvider();
  assert.equal(p.name, 'fake');
  assert.equal(p.dim, EMBED_DIM);
});

// ---------------------------------------------------------------------------
// Ingestão: linhas em chunks == vec_chunks == nº de chunks; metadados.
// ---------------------------------------------------------------------------
test('ingest persiste chunks + vetores + metadados', async () => {
  const mem = openMemory(':memory:');
  const text = 'palavra '.repeat(200); // garante múltiplos chunks
  const { chunks } = await mem.ingest({
    ticketId: 'DIM-12',
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
  assert.equal(row.ticket_id, 'DIM-12');
  assert.equal(row.stage, 'execution');
  assert.equal(row.kind, 'spec');
  assert.equal(row.source, 'context-spec');
  assert.equal(row.chunk_index, 0);
  mem.close();
});

// ---------------------------------------------------------------------------
// Idempotência por `source`: reingest substitui em vez de duplicar.
// ---------------------------------------------------------------------------
test('ingest é idempotente por source (reingest não duplica, sem órfãos)', async () => {
  const mem = openMemory(':memory:');
  const text = 'palavra '.repeat(200); // múltiplos chunks
  const doc = {
    ticketId: 'DIM-23',
    stage: 'execution',
    kind: 'spec',
    source: 'context-spec',
    text,
    chunkOpts: { size: 200, overlap: 40 },
  };

  const first = await mem.ingest(doc);
  assert.ok(first.chunks > 1, 'primeira ingestão gera vários chunks');

  const second = await mem.ingest(doc); // mesmo source + mesmo texto
  assert.equal(second.chunks, first.chunks, 'reingest gera o mesmo nº de chunks');

  const nChunks = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  const nVec = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
  assert.equal(nChunks, first.chunks, 'COUNT(chunks) não cresce no reingest');
  assert.equal(nChunks, nVec, 'sem órfãos: chunks == vec_chunks');
  mem.close();
});

test('ingest com source=null não deduplica (contagem cresce)', async () => {
  const mem = openMemory(':memory:');
  const doc = { ticketId: 'DIM-23', source: null, text: 'sem fonte definida' };

  await mem.ingest(doc);
  const afterFirst = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  await mem.ingest(doc);
  const afterSecond = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;

  assert.equal(afterSecond, afterFirst * 2, 'source=null acumula (sem dedup)');
  const nVec = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
  assert.equal(afterSecond, nVec, 'sem órfãos mesmo com source=null');
  mem.close();
});

test('reingest de uma source não afeta outras sources nem source IS NULL', async () => {
  const mem = openMemory(':memory:');
  await mem.ingest({ ticketId: 'A', source: 'src-a', text: 'conteúdo da fonte A' });
  await mem.ingest({ ticketId: 'B', source: 'src-b', text: 'conteúdo da fonte B' });
  await mem.ingest({ ticketId: 'N', source: null, text: 'conteúdo sem fonte' });

  const countBy = (where, ...args) =>
    mem.db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE ${where}`).get(...args).n;
  const bBefore = countBy('source = ?', 'src-b');
  const nullBefore = countBy('source IS NULL');

  // reingest só de src-a
  await mem.ingest({ ticketId: 'A', source: 'src-a', text: 'conteúdo da fonte A' });

  assert.equal(countBy('source = ?', 'src-a'), 1, 'src-a não duplicou');
  assert.equal(countBy('source = ?', 'src-b'), bBefore, 'src-b intacta');
  assert.equal(countBy('source IS NULL'), nullBefore, 'source IS NULL intacta');

  const nChunks = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  const nVec = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
  assert.equal(nChunks, nVec, 'sem órfãos após reingest isolado');
  mem.close();
});

// ---------------------------------------------------------------------------
// Query por similaridade: recupera o chunk esperado como top-1, respeita k.
// ---------------------------------------------------------------------------
test('query retorna top-k por similaridade respeitando k', async () => {
  const mem = openMemory(':memory:');
  const docs = [
    { ticketId: 'T1', text: 'gato preto dorme no sofá' },
    { ticketId: 'T2', text: 'arquitetura de microserviços com filas' },
    { ticketId: 'T3', text: 'receita de bolo de cenoura' },
    { ticketId: 'T4', text: 'banco de dados vetorial sqlite' },
  ];
  await mem.ingestBatch(docs);

  // texto idêntico ao de T2 → fake produz o MESMO vetor → distância ~0 → top-1.
  const res = await mem.query('arquitetura de microserviços com filas', { k: 2 });
  assert.equal(res.length, 2, 'respeita k');
  assert.equal(res[0].ticket_id, 'T2', 'top-1 é o chunk esperado');
  mem.close();
});

// ---------------------------------------------------------------------------
// Ranking por distance ascendente.
// ---------------------------------------------------------------------------
test('query ordena por distance ascendente', async () => {
  const mem = openMemory(':memory:');
  await mem.ingestBatch([
    { ticketId: 'A', text: 'alpha beta gamma' },
    { ticketId: 'B', text: 'delta epsilon zeta' },
    { ticketId: 'C', text: 'eta theta iota' },
  ]);
  const res = await mem.query('alpha beta gamma', { k: 3 });
  for (let i = 1; i < res.length; i++) {
    assert.ok(res[i - 1].distance <= res[i].distance, 'distância não-decrescente');
  }
  mem.close();
});

// ---------------------------------------------------------------------------
// Query híbrida: filtro de metadados exclui chunks fora do escopo.
// ---------------------------------------------------------------------------
test('query híbrida filtra por ticket/stage/kind', async () => {
  const mem = openMemory(':memory:');
  await mem.ingestBatch([
    { ticketId: 'T1', stage: 'review', kind: 'note', text: 'mesmo conteúdo compartilhado' },
    { ticketId: 'T2', stage: 'execution', kind: 'spec', text: 'mesmo conteúdo compartilhado' },
    { ticketId: 'T2', stage: 'review', kind: 'note', text: 'mesmo conteúdo compartilhado' },
  ]);

  const byTicket = await mem.query('mesmo conteúdo compartilhado', {
    filter: { ticket_id: 'T2' },
    k: 10,
  });
  assert.ok(byTicket.length > 0);
  assert.ok(byTicket.every((r) => r.ticket_id === 'T2'), 'só T2');

  const byStageKind = await mem.query('mesmo conteúdo compartilhado', {
    filter: { ticket_id: 'T2', stage: 'execution', kind: 'spec' },
    k: 10,
  });
  assert.equal(byStageKind.length, 1, 'só o chunk T2/execution/spec');
  assert.equal(byStageKind[0].stage, 'execution');
  assert.equal(byStageKind[0].kind, 'spec');
  mem.close();
});

// ---------------------------------------------------------------------------
// Isolamento: a suíte não carrega transformers (sem rede).
// ---------------------------------------------------------------------------
test('transformers.js NÃO foi carregado pela suíte', () => {
  const loaded = Object.keys(require.cache).some((p) =>
    p.includes(path.join('@huggingface', 'transformers'))
  );
  assert.equal(loaded, false, 'provider real não deve ser importado nos testes');
});
