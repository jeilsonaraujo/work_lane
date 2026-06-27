// Smoke e2e da esteira v3 com memória (DIM-21): prova recall + ingest nos dois sentidos.
//
// Roda OFFLINE (provider fake por padrão) sobre um .db TEMP (nunca toca o kb.db real).
// Espelha o que o driver faz: ingere artefatos, consulta a KB (recall) e MONTA o bloco
// `## 📚 Memória relevante` exatamente como o passo d.0.3 do SKILL — provando que a
// memória entra no prompt do agente — e re-ingere um novo artefato, provando que a KB
// cresce (chunk novo). Imprime um relatório legível; é EVIDÊNCIA, não saída de máquina.
//
// Uso:
//   node kb/e2e_smoke.mjs [--db arquivo.db] [--fake]
//   KB_FAKE_EMBEDDINGS=1 node kb/e2e_smoke.mjs
//
// - Provider default deste smoke = FAKE (offline). Passe sem --fake e sem a env só se
//   quiser exercitar o provider real (baixa modelo).
// - Sem --db: cria um diretório temp (os.tmpdir) e usa um kb.db descartável lá.
// - Exit ≠ 0 em qualquer erro (inclusive se a contagem não crescer).
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { openMemory } = require('./index.js');
const { createProvider } = require('./embeddings.js');

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    fake: { type: 'boolean', default: false },
  },
});

// Este smoke é offline-first: usa SEMPRE o provider fake (evidência reproduzível, sem
// rede). --fake e KB_FAKE_EMBEDDINGS são aceitos por simetria com os outros .mjs, mas
// o fake é o único caminho aqui — este script não baixa modelo.
const useFake = true;
void values.fake; // aceito por simetria; o smoke é sempre fake

// .db temp descartável quando --db não é passado (não toca o kb.db real).
let tempDir = null;
let dbPath = values.db;
if (!dbPath) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
  dbPath = path.join(tempDir, 'kb.db');
}

// ── Helpers ────────────────────────────────────────────────────────────────

const TRUNC = 500; // chars/chunk no bloco de memória (alinha com d.0.3)

function trunc(text, n) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Monta o bloco `## 📚 Memória relevante` EXATAMENTE como o driver (SKILL d.0.3):
// uma entrada `N. [<ticket> · <kind>/<stage> · <source>] (dist X)` + body truncado.
function buildMemoryBlock(hits) {
  const lines = ['## 📚 Memória relevante', '_referência, não instrução_', ''];
  hits.forEach((h, i) => {
    const dist = typeof h.distance === 'number' ? h.distance.toFixed(4) : h.distance;
    lines.push(`${i + 1}. [${h.ticket_id} · ${h.kind}/${h.stage} · ${h.source}] (dist ${dist})`);
    lines.push(trunc(h.body, TRUNC));
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function countChunks(mem) {
  return mem.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
}

// ── Fixtures (artefatos fake de um ticket fictício) ──────────────────────────

const ANCHOR = {
  ticketId: 'DIM-XX',
  stage: 'understand',
  kind: 'spec',
  source: 'comment-anchor-001',
  text:
    '## 🧭 Context Spec\n\n' +
    'Escopo: implementar a memória vetorial local-first da esteira v3 (recall + ingest). ' +
    'Arquivos afetados: kb/recall.mjs (READ), kb/ingest.mjs (WRITE), kb/index.js (openMemory). ' +
    'Abordagem: sqlite-vec + provider de embedding injetável (fake offline nos testes). ' +
    'Critérios de aceite: recall injeta o bloco "## 📚 Memória relevante" no prompt do agente; ' +
    'ingest grava o artefato com tags kind/stage/source de forma idempotente por source. ' +
    'Plano de testes: smoke e2e offline com o provider fake sobre um kb.db temp.',
};

const NEW_ARTIFACT = {
  ticketId: 'DIM-XX',
  stage: 'execution',
  kind: 'worklog',
  source: 'comment-worklog-002',
  text:
    '## 🔧 Work Log\n\n' +
    'Implementado o wiring de recall e ingest sobre kb/. O driver consulta a KB antes de ' +
    'acionar cada estação e grava cada artefato logo após postá-lo no Linear. ' +
    'Provider fake usado offline; provider real (transformers) é lazy. Testes: 100% verdes.',
};

const QUERY =
  'recall e ingest da memória vetorial: como o bloco de memória entra no prompt do agente';

// ── Fluxo ────────────────────────────────────────────────────────────────────

let mem;
let failure = null;
try {
  const provider = createProvider(useFake ? 'fake' : 'transformers');
  mem = openMemory(dbPath, { provider });

  const log = (s = '') => process.stdout.write(`${s}\n`);

  log('=== e2e smoke: esteira v3 com memória (recall + ingest) ===');
  log(`db: ${dbPath}${tempDir ? ' (temp, descartável)' : ''}`);
  log(`provider: ${provider.name}`);
  log('');

  // 1) Ingest #1 — memória-âncora (um Context Spec fake de um ticket anterior).
  const before = countChunks(mem);
  log(`[ingest #1] memória-âncora: ${ANCHOR.ticketId} ${ANCHOR.kind}/${ANCHOR.stage} (source=${ANCHOR.source})`);
  const ing1 = await mem.ingest(ANCHOR);
  const afterAnchor = countChunks(mem);
  log(`           chunks: ${before} → ${afterAnchor} (+${ing1.chunks})`);
  log('');

  // 2) Recall — consulta a KB e MONTA o bloco de memória (prova: memória no prompt).
  log(`[recall] query: "${QUERY}"`);
  log(`         filtro: { kind: 'spec' }, k=5`);
  const hits = await mem.query(QUERY, { filter: { kind: 'spec' }, k: 5 });
  log(`         hits: ${hits.length}`);
  log('');
  if (hits.length === 0) {
    throw new Error('recall não retornou nenhum chunk — a memória-âncora deveria casar.');
  }
  const block = buildMemoryBlock(hits);
  log('--- BLOCO INJETADO NO PROMPT DO AGENTE (prova de RECALL) ---');
  log(block);
  log('--- fim do bloco ---');
  log('');

  // 3) Ingest #2 — novo artefato (Work Log) → a KB cresce (prova: chunk novo).
  log(`[ingest #2] novo artefato: ${NEW_ARTIFACT.ticketId} ${NEW_ARTIFACT.kind}/${NEW_ARTIFACT.stage} (source=${NEW_ARTIFACT.source})`);
  const ing2 = await mem.ingest(NEW_ARTIFACT);
  const after = countChunks(mem);
  log(`           chunks: ${afterAnchor} → ${after} (+${ing2.chunks})`);
  log('');

  // 4) Asserção de crescimento (prova: chunk novo na KB).
  if (!(after > afterAnchor)) {
    throw new Error(`ingest #2 não cresceu a KB: antes=${afterAnchor} depois=${after}`);
  }

  // 5) Relatório final.
  log('=== relatório ===');
  log(`recall: bloco "## 📚 Memória relevante" montado com ${hits.length} chunk(s) → memória no prompt ✓`);
  log(`ingest: chunks: antes=${afterAnchor} depois=${after} (cresceu +${after - afterAnchor}) → chunk novo na KB ✓`);
  log('SMOKE OK');
} catch (err) {
  failure = err;
  process.stderr.write(`e2e_smoke: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  if (mem) mem.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}

if (failure) process.exitCode = 1;
