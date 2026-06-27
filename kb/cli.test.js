'use strict';

// Smoke e2e das CLIs recall.mjs / ingest.mjs (DIM-17).
//
// Invoca os scripts como subprocessos reais (como o driver faria) e força o
// provider fake (offline) via --fake + KB_FAKE_EMBEDDINGS, sobre um .db temp.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RECALL = path.join(__dirname, 'recall.mjs');
const INGEST = path.join(__dirname, 'ingest.mjs');

// Ambiente offline determinístico para todos os subprocessos.
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

test('ingest via stdin produz chunks>0 e ids.length === chunks; saída é JSON', () => {
  withTempDb((db) => {
    const res = run(INGEST, ['--ticket', 'DIM-17', '--kind', 'doc', '--fake', '--db', db], {
      input: 'A memória usa sqlite-vec sobre better-sqlite3 com embeddings local-first.',
    });
    assert.equal(res.status, 0, `ingest deveria sair 0. stderr=${res.stderr}`);

    let out;
    assert.doesNotThrow(() => {
      out = JSON.parse(res.stdout);
    }, 'stdout do ingest deve ser JSON parseável');

    assert.ok(out.chunks > 0, 'chunks > 0');
    assert.equal(out.ids.length, out.chunks, 'ids.length === chunks');
  });
});

test('recall depois do ingest retorna top-1 = texto ingerido; saída é JSON', () => {
  withTempDb((db) => {
    const texto = 'O chunking é determinístico por tamanho e overlap.';
    const ing = run(INGEST, ['--ticket', 'DIM-17', '--fake', '--db', db], { input: texto });
    assert.equal(ing.status, 0, `ingest deveria sair 0. stderr=${ing.stderr}`);

    const rec = run(RECALL, [texto, '--k', '3', '--fake', '--db', db]);
    assert.equal(rec.status, 0, `recall deveria sair 0. stderr=${rec.stderr}`);

    let results;
    assert.doesNotThrow(() => {
      results = JSON.parse(rec.stdout);
    }, 'stdout do recall deve ser JSON parseável');

    assert.ok(Array.isArray(results), 'recall retorna array');
    assert.ok(results.length > 0, 'recall retorna ao menos 1 resultado');
    assert.equal(results[0].body, texto, 'top-1 é o texto ingerido');
    assert.equal(results[0].ticket_id, 'DIM-17', 'metadado ticket_id presente');
  });
});

test('recall com --ticket filtra por ticket_id', () => {
  withTempDb((db) => {
    run(INGEST, ['--ticket', 'AAA-1', '--fake', '--db', db], { input: 'alpha um dois tres' });
    run(INGEST, ['--ticket', 'BBB-2', '--fake', '--db', db], { input: 'beta quatro cinco seis' });

    const rec = run(RECALL, ['qualquer consulta', '--ticket', 'AAA-1', '--fake', '--db', db]);
    assert.equal(rec.status, 0, `recall deveria sair 0. stderr=${rec.stderr}`);
    const results = JSON.parse(rec.stdout);
    assert.ok(results.length > 0, 'há resultados para AAA-1');
    for (const r of results) {
      assert.equal(r.ticket_id, 'AAA-1', 'todos os resultados são do ticket filtrado');
    }
  });
});

test('ingest com stdin vazio retorna {chunks:0, ids:[]} (não é erro)', () => {
  withTempDb((db) => {
    const res = run(INGEST, ['--ticket', 'DIM-17', '--fake', '--db', db], { input: '' });
    assert.equal(res.status, 0, `ingest vazio deveria sair 0. stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.chunks, 0);
    assert.deepEqual(out.ids, []);
  });
});

test('ingest sem --ticket sai com código != 0 e stderr não-vazio', () => {
  const res = run(INGEST, ['--fake'], { input: 'qualquer texto' });
  assert.notEqual(res.status, 0, 'deve falhar sem --ticket');
  assert.ok(res.stderr.trim().length > 0, 'stderr não-vazio');
  assert.equal(res.stdout.trim(), '', 'nada de JSON em stdout no erro');
});

test('recall sem query posicional sai com código != 0 e stderr não-vazio', () => {
  withTempDb((db) => {
    const res = run(RECALL, ['--fake', '--db', db]);
    assert.notEqual(res.status, 0, 'deve falhar sem query');
    assert.ok(res.stderr.trim().length > 0, 'stderr não-vazio');
  });
});
