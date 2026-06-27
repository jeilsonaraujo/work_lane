'use strict';

// Wrapper de teste do smoke e2e (WLN-21): roda e2e_smoke.mjs como subprocesso real,
// offline (provider fake) sobre um .db temp, e assere as DUAS provas:
//   - recall: a saída contém o bloco "## 📚 Memória relevante" (memória no prompt);
//   - ingest: a contagem de chunks CRESCEU (chunk novo na KB).

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

test('e2e_smoke: exit 0, injeta bloco de memória e a KB cresce', () => {
  withTempDb((db) => {
    const res = run(['--fake', '--db', db]);
    assert.equal(res.status, 0, `smoke deveria sair 0. stderr=${res.stderr}`);

    // Prova de RECALL: o bloco que o driver injeta no prompt aparece na saída.
    assert.match(res.stdout, /## 📚 Memória relevante/, 'saída contém o bloco de memória');
    assert.match(res.stdout, /prova de RECALL/, 'saída marca a evidência de recall');

    // Prova de INGEST: a contagem subiu (antes=X depois=Y, com depois>antes).
    const m = res.stdout.match(/antes=(\d+)\s+depois=(\d+)/);
    assert.ok(m, 'saída reporta "antes=X depois=Y"');
    const before = Number(m[1]);
    const after = Number(m[2]);
    assert.ok(after > before, `KB deve crescer: antes=${before} depois=${after}`);

    assert.match(res.stdout, /SMOKE OK/, 'smoke conclui com SMOKE OK');
  });
});
