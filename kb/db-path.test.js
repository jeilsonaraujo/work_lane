'use strict';

// Regressão do DIM-24: o default de `--db` é ancorado na RAIZ do repo, não no CWD.
//
// Prova de integração: ingest rodado de um CWD e recall rodado de OUTRO CWD — ambos
// SEM `--db` — convergem no MESMO kb.db (o da raiz), então o recall acha o chunk que o
// ingest gravou. Também garante que NENHUM kb.db é criado nos CWDs temporários.
//
// Cuidado: este teste grava no kb.db REAL da raiz. Usa um `source`/`ticket` sentinela
// e limpa via deleteBySource (idempotente, DIM-23) no finally, sem tocar outros dados.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openMemory } = require('./index.js');

const RECALL = path.join(__dirname, 'recall.mjs');
const INGEST = path.join(__dirname, 'ingest.mjs');

// O kb.db real da raiz = o MESMO default que recall.mjs/ingest.mjs resolvem.
const ROOT_DB = path.resolve(__dirname, '..', 'kb.db');

// Ambiente offline determinístico para todos os subprocessos.
const FAKE_ENV = { ...process.env, KB_FAKE_EMBEDDINGS: '1' };

// Sentinelas exclusivos deste teste (evitam colidir/limpar dados reais).
const SENTINEL_TICKET = 'DIM-24-DBPATH-TEST';
const SENTINEL_SOURCE = 'dim-24-db-path-test-sentinel';
const SENTINEL_TEXT =
  'sentinela DIM-24: prova de que o default de --db é ancorado na raiz do repo, ' +
  'convergindo recall e ingest no mesmo kb.db de qualquer CWD.';

function run(script, args, { cwd, input } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    input: input ?? '',
    encoding: 'utf8',
    env: FAKE_ENV,
  });
}

function cleanup(dirs) {
  // Remove o que o teste gravou no kb.db real (idempotente) e os dirs temp.
  try {
    const mem = openMemory(ROOT_DB);
    try {
      mem.deleteBySource(SENTINEL_SOURCE);
    } finally {
      mem.close();
    }
  } catch {
    // kb.db pode nem existir se o ingest falhou antes de criar — nada a limpar.
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test('default de --db é ancorado na raiz: ingest (CWD=A) e recall (CWD=B) usam o MESMO kb.db', () => {
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cwd-a-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cwd-b-'));
  try {
    // Ingest de dentro de tmpA, SEM --db (usa o default ancorado na raiz).
    const ing = run(
      INGEST,
      ['--ticket', SENTINEL_TICKET, '--source', SENTINEL_SOURCE, '--fake'],
      { cwd: tmpA, input: SENTINEL_TEXT },
    );
    assert.equal(ing.status, 0, `ingest deveria sair 0. stderr=${ing.stderr}`);
    const ingOut = JSON.parse(ing.stdout);
    assert.ok(ingOut.chunks > 0, 'ingest gravou ao menos 1 chunk');

    // Recall de dentro de tmpB, SEM --db, filtrando pelo ticket sentinela.
    const rec = run(
      RECALL,
      [SENTINEL_TEXT, '--ticket', SENTINEL_TICKET, '--k', '5', '--fake'],
      { cwd: tmpB },
    );
    assert.equal(rec.status, 0, `recall deveria sair 0. stderr=${rec.stderr}`);
    const results = JSON.parse(rec.stdout);
    assert.ok(Array.isArray(results), 'recall retorna array');
    assert.ok(
      results.length > 0,
      'recall (CWD=B) achou o chunk gravado pelo ingest (CWD=A) → mesmo kb.db da raiz',
    );
    assert.ok(
      results.some((r) => r.ticket_id === SENTINEL_TICKET && r.source === SENTINEL_SOURCE),
      'o chunk retornado é exatamente o sentinela ingerido',
    );

    // Nenhum kb.db parasita nos CWDs temporários (o antigo bug do default relativo).
    assert.ok(!fs.existsSync(path.join(tmpA, 'kb.db')), 'nenhum kb.db criado no CWD do ingest');
    assert.ok(!fs.existsSync(path.join(tmpB, 'kb.db')), 'nenhum kb.db criado no CWD do recall');
  } finally {
    cleanup([tmpA, tmpB]);
  }
});
