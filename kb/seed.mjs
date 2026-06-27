// CLI de seed: popula a KB com os docs base do repo (kind=doc) de forma idempotente.
// Superfície fina sobre a API de `kb/` para dar contexto base aos agentes (DIM-18).
//
// Uso:
//   node kb/seed.mjs [--db arquivo.db] [--fake]
//
// - Provider default = real (transformers); --fake (ou KB_FAKE_EMBEDDINGS) usa o fake.
// - Idempotente: cada doc é removido por `source` (deleteBySource) antes de reingerir,
//   então rodar 2x não duplica.
// - Cada doc entra com kind='doc', source=<caminho relativo>, stage=null, ticketId='REPO'.
// - Arquivo ausente: avisa em stderr e pula (não falha).
// - SOMENTE JSON vai para stdout; erros vão para stderr + exit 1.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { openMemory } = require('./index.js');
const { createProvider } = require('./embeddings.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// kb.db default ancorado na RAIZ do repo (não no CWD) — o MESMO DB que recall/ingest
// resolvem por padrão, independente do diretório de onde os scripts são chamados.
const DEFAULT_DB = path.resolve(repoRoot, 'kb.db');

// Docs base do repo, em caminhos relativos à RAIZ. São os `source` das tags.
const DOCS = ['CLAUDE.md', 'README.md', 'kb/README.md'];

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: DEFAULT_DB },
    fake: { type: 'boolean', default: false },
  },
});

const useFake = values.fake || Boolean(process.env.KB_FAKE_EMBEDDINGS);

let mem;
try {
  const provider = createProvider(useFake ? 'fake' : 'transformers');
  mem = openMemory(values.db, { provider });

  const seeded = [];
  let total = 0;
  for (const rel of DOCS) {
    const abs = path.resolve(repoRoot, rel);
    if (!existsSync(abs)) {
      process.stderr.write(`seed: doc ausente, pulando: ${rel}\n`);
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    // Idempotência: limpa o que existia para esta source antes de reingerir.
    mem.deleteBySource(rel);
    const { chunks } = await mem.ingest({
      ticketId: 'REPO',
      stage: null,
      kind: 'doc',
      source: rel,
      text,
    });
    seeded.push({ source: rel, chunks });
    total += chunks;
  }

  console.log(JSON.stringify({ seeded, total }));
} catch (err) {
  process.stderr.write(`seed: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  if (mem) mem.close();
}
