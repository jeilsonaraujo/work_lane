'use strict';

// Smoke e2e da CLI seed.mjs + teste direto de deleteBySource (WLN-18).
//
// Invoca seed.mjs/recall.mjs como subprocessos reais (como o driver faria) e força
// o provider fake (offline) via --fake + KB_FAKE_EMBEDDINGS, sobre um .db temp.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openMemory } = require('./index.js');

const SEED = path.join(__dirname, 'seed.mjs');
const RECALL = path.join(__dirname, 'recall.mjs');

// Ambiente offline determinístico para todos os subprocessos.
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

// Conta linhas em chunks e vec_chunks abrindo o .db diretamente.
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

test('seed 1x: exit 0, JSON parseável, total>0 e chunks persistidos', () => {
  withTempDb((db) => {
    const res = run(SEED, ['--fake', '--db', db]);
    assert.equal(res.status, 0, `seed deveria sair 0. stderr=${res.stderr}`);

    let out;
    assert.doesNotThrow(() => {
      out = JSON.parse(res.stdout);
    }, 'stdout do seed deve ser JSON parseável');

    assert.ok(out.total > 0, 'total > 0');
    assert.ok(Array.isArray(out.seeded), 'seeded é array');
    assert.ok(out.seeded.length > 0, 'pelo menos um doc semeado');

    const { chunks } = counts(db);
    assert.equal(chunks, out.total, 'chunks persistidos === total reportado');
  });
});

test('seed 2x: contagem estável (idempotência) e sem órfãos', () => {
  withTempDb((db) => {
    const first = run(SEED, ['--fake', '--db', db]);
    assert.equal(first.status, 0, `1º seed deveria sair 0. stderr=${first.stderr}`);
    const after1 = counts(db);

    const second = run(SEED, ['--fake', '--db', db]);
    assert.equal(second.status, 0, `2º seed deveria sair 0. stderr=${second.stderr}`);
    const after2 = counts(db);

    assert.equal(after2.chunks, after1.chunks, 'seed 2x não duplica chunks');
    assert.equal(after2.chunks, after2.vec, 'COUNT(chunks) === COUNT(vec_chunks) (sem órfãos)');
  });
});

test('recall --kind doc encontra o doc semeado pelo seed', () => {
  withTempDb((db) => {
    const seed = run(SEED, ['--fake', '--db', db]);
    assert.equal(seed.status, 0, `seed deveria sair 0. stderr=${seed.stderr}`);

    // "Loop Engineering" é um termo presente no CLAUDE.md.
    const rec = run(RECALL, ['Loop Engineering esteira de tasks', '--kind', 'doc', '--fake', '--db', db]);
    assert.equal(rec.status, 0, `recall deveria sair 0. stderr=${rec.stderr}`);

    const results = JSON.parse(rec.stdout);
    assert.ok(Array.isArray(results), 'recall retorna array');
    assert.ok(results.length > 0, 'recall retorna ao menos 1 resultado');
    for (const r of results) {
      assert.equal(r.kind, 'doc', 'todos os resultados são kind=doc');
    }
    const sources = new Set(results.map((r) => r.source));
    assert.ok(sources.has('CLAUDE.md'), 'CLAUDE.md está entre as sources retornadas');
  });
});

test('seed também ingere código-fonte (kind=code): kb/index.js + ao menos um de .claude/', () => {
  withTempDb((db) => {
    const res = run(SEED, ['--fake', '--db', db]);
    assert.equal(res.status, 0, `seed deveria sair 0. stderr=${res.stderr}`);

    const out = JSON.parse(res.stdout);
    const bySource = new Map(out.seeded.map((s) => [s.source, s]));

    assert.ok(bySource.has('kb/index.js'), 'kb/index.js está entre as sources semeadas');
    assert.equal(bySource.get('kb/index.js').kind, 'code', 'kb/index.js entra como kind=code');
    assert.ok(bySource.get('kb/index.js').chunks > 0, 'kb/index.js gerou ao menos 1 chunk');

    assert.ok(bySource.has('kb/seed.mjs'), 'kb/seed.mjs está entre as sources semeadas');
    assert.equal(bySource.get('kb/seed.mjs').kind, 'code', 'kb/seed.mjs entra como kind=code');

    const claudeCode = out.seeded.filter(
      (s) => s.kind === 'code' && s.source.startsWith('.claude/')
    );
    assert.ok(claudeCode.length > 0, 'ao menos um prompt de .claude/ semeado como code');
    assert.ok(
      claudeCode.some((s) => s.source === '.claude/skills/esteira/SKILL.md'),
      '.claude/skills/esteira/SKILL.md está entre as sources de code'
    );
  });
});

test('recall --kind code por símbolo real encontra kb/index.js', () => {
  withTempDb((db) => {
    const seed = run(SEED, ['--fake', '--db', db]);
    assert.equal(seed.status, 0, `seed deveria sair 0. stderr=${seed.stderr}`);

    const rec = run(RECALL, ['openMemory ingest', '--kind', 'code', '--k', '10', '--fake', '--db', db]);
    assert.equal(rec.status, 0, `recall deveria sair 0. stderr=${rec.stderr}`);

    const results = JSON.parse(rec.stdout);
    assert.ok(Array.isArray(results), 'recall retorna array');
    assert.ok(results.length > 0, 'recall retorna ao menos 1 resultado');
    for (const r of results) {
      assert.equal(r.kind, 'code', 'todos os resultados são kind=code');
    }
    const sources = new Set(results.map((r) => r.source));
    assert.ok(sources.has('kb/index.js'), 'kb/index.js está entre as sources retornadas');
  });
});

test('seed não inclui node_modules, *.db, *.test.js nem .claude/worktrees/**', () => {
  withTempDb((db) => {
    const res = run(SEED, ['--fake', '--db', db]);
    assert.equal(res.status, 0, `seed deveria sair 0. stderr=${res.stderr}`);

    const out = JSON.parse(res.stdout);
    for (const { source } of out.seeded) {
      const segments = source.split('/');
      assert.ok(!segments.includes('node_modules'), `source não sob node_modules: ${source}`);
      assert.ok(!segments.includes('.git'), `source não sob .git: ${source}`);
      assert.ok(!segments.includes('worktrees'), `source não sob worktrees: ${source}`);
      assert.ok(!source.endsWith('.db'), `source não é *.db: ${source}`);
      assert.ok(!source.endsWith('.test.js'), `source não é *.test.js: ${source}`);
    }
  });
});

test('deleteBySource remove só a source alvo, sem deixar órfãos', async () => {
  withTempDb(async (db) => {
    const mem = openMemory(db);
    try {
      await mem.ingest({ ticketId: 'REPO', kind: 'doc', source: 'a.md', text: 'alpha um dois tres quatro' });
      await mem.ingest({ ticketId: 'REPO', kind: 'doc', source: 'b.md', text: 'beta cinco seis sete oito' });

      const before = {
        chunks: mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n,
        vec: mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n,
      };
      assert.ok(before.chunks > 0, 'há chunks antes do delete');
      assert.equal(before.chunks, before.vec, 'pareado antes do delete');

      const removed = mem.deleteBySource('a.md');
      assert.ok(removed > 0, 'deleteBySource reporta linhas removidas');

      const aLeft = mem.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE source = 'a.md'").get().n;
      const bLeft = mem.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE source = 'b.md'").get().n;
      const vecLeft = mem.db.prepare('SELECT COUNT(*) AS n FROM vec_chunks').get().n;
      const chunksLeft = mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;

      assert.equal(aLeft, 0, 'source a.md totalmente removida');
      assert.ok(bLeft > 0, 'source b.md intacta');
      assert.equal(chunksLeft, vecLeft, 'sem órfãos após o delete');
      assert.equal(removed, before.chunks - chunksLeft, 'removed casa com a diferença de contagem');
    } finally {
      mem.close();
    }
  });
});
