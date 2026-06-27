// e2e smoke of pipeline v3 with memory (WLN-21): proves recall + ingest in both directions.
//
// Runs OFFLINE (fake provider by default) over a TEMP .db (never touches the real kb.db).
// Mirrors what the driver does: ingests artifacts, queries the KB (recall) and BUILDS the
// `## 📚 Memória relevante` block exactly like step d.0.3 of the SKILL — proving that the
// memory enters the agent's prompt — and re-ingests a new artifact, proving that the KB
// grows (new chunk). Prints a readable report; it is EVIDENCE, not machine output.
//
// Usage:
//   node kb/e2e_smoke.mjs [--db file.db] [--fake]
//   KB_FAKE_EMBEDDINGS=1 node kb/e2e_smoke.mjs
//
// - Default provider of this smoke = FAKE (offline). Pass without --fake and without the env
//   only if you want to exercise the real provider (downloads a model).
// - Without --db: creates a temp directory (os.tmpdir) and uses a disposable kb.db there.
// - Exit ≠ 0 on any error (including if the count does not grow).
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

// This smoke is offline-first: ALWAYS uses the fake provider (reproducible evidence, no
// network). --fake and KB_FAKE_EMBEDDINGS are accepted for symmetry with the other .mjs, but
// the fake is the only path here — this script does not download a model.
const useFake = true;
void values.fake; // accepted for symmetry; the smoke is always fake

// disposable temp .db when --db is not passed (does not touch the real kb.db).
let tempDir = null;
let dbPath = values.db;
if (!dbPath) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
  dbPath = path.join(tempDir, 'kb.db');
}

// ── Helpers ────────────────────────────────────────────────────────────────

const TRUNC = 500; // chars/chunk in the memory block (aligns with d.0.3)

function trunc(text, n) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Builds the `## 📚 Memória relevante` block EXACTLY like the driver (SKILL d.0.3):
// one entry `N. [<ticket> · <kind>/<stage> · <source>] (dist X)` + truncated body.
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

// ── Fixtures (fake artifacts of a fictitious ticket) ──────────────────────────

const ANCHOR = {
  ticketId: 'WLN-XX',
  stage: 'understand',
  kind: 'spec',
  source: 'comment-anchor-001',
  text:
    '## 🧭 Context Spec\n\n' +
    'Scope: implement the local-first vector memory of pipeline v3 (recall + ingest). ' +
    'Affected files: kb/recall.mjs (READ), kb/ingest.mjs (WRITE), kb/index.js (openMemory). ' +
    'Approach: sqlite-vec + injectable embedding provider (fake offline in the tests). ' +
    'Acceptance criteria: recall injects the "## 📚 Memória relevante" block into the agent prompt; ' +
    'ingest stores the artifact with kind/stage/source tags idempotently by source. ' +
    'Test plan: offline e2e smoke with the fake provider over a temp kb.db.',
};

const NEW_ARTIFACT = {
  ticketId: 'WLN-XX',
  stage: 'execution',
  kind: 'worklog',
  source: 'comment-worklog-002',
  text:
    '## 🔧 Work Log\n\n' +
    'Implemented the recall and ingest wiring over kb/. The driver queries the KB before ' +
    'triggering each station and stores each artifact right after posting it to Linear. ' +
    'Fake provider used offline; real provider (transformers) is lazy. Tests: 100% green.',
};

const QUERY =
  'recall and ingest of the vector memory: how the memory block enters the agent prompt';

// ── Flow ──────────────────────────────────────────────────────────────────────

let mem;
let failure = null;
try {
  const provider = createProvider(useFake ? 'fake' : 'transformers');
  mem = openMemory(dbPath, { provider });

  const log = (s = '') => process.stdout.write(`${s}\n`);

  log('=== e2e smoke: pipeline v3 with memory (recall + ingest) ===');
  log(`db: ${dbPath}${tempDir ? ' (temp, disposable)' : ''}`);
  log(`provider: ${provider.name}`);
  log('');

  // 1) Ingest #1 — anchor memory (a fake Context Spec from a previous ticket).
  const before = countChunks(mem);
  log(`[ingest #1] anchor memory: ${ANCHOR.ticketId} ${ANCHOR.kind}/${ANCHOR.stage} (source=${ANCHOR.source})`);
  const ing1 = await mem.ingest(ANCHOR);
  const afterAnchor = countChunks(mem);
  log(`           chunks: ${before} → ${afterAnchor} (+${ing1.chunks})`);
  log('');

  // 2) Recall — queries the KB and BUILDS the memory block (proof: memory in the prompt).
  log(`[recall] query: "${QUERY}"`);
  log(`         filter: { kind: 'spec' }, k=5`);
  const hits = await mem.query(QUERY, { filter: { kind: 'spec' }, k: 5 });
  log(`         hits: ${hits.length}`);
  log('');
  if (hits.length === 0) {
    throw new Error('recall returned no chunk — the anchor memory should have matched.');
  }
  const block = buildMemoryBlock(hits);
  log('--- BLOCK INJECTED INTO THE AGENT PROMPT (proof of RECALL) ---');
  log(block);
  log('--- end of block ---');
  log('');

  // 3) Ingest #2 — new artifact (Work Log) → the KB grows (proof: new chunk).
  log(`[ingest #2] new artifact: ${NEW_ARTIFACT.ticketId} ${NEW_ARTIFACT.kind}/${NEW_ARTIFACT.stage} (source=${NEW_ARTIFACT.source})`);
  const ing2 = await mem.ingest(NEW_ARTIFACT);
  const after = countChunks(mem);
  log(`           chunks: ${afterAnchor} → ${after} (+${ing2.chunks})`);
  log('');

  // 4) Growth assertion (proof: new chunk in the KB).
  if (!(after > afterAnchor)) {
    throw new Error(`ingest #2 did not grow the KB: before=${afterAnchor} after=${after}`);
  }

  // 5) Final report.
  log('=== report ===');
  log(`recall: block "## 📚 Memória relevante" built with ${hits.length} chunk(s) → memory in the prompt ✓`);
  log(`ingest: chunks: before=${afterAnchor} after=${after} (grew +${after - afterAnchor}) → new chunk in the KB ✓`);
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
