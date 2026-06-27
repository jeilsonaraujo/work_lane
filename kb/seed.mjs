// CLI de seed: popula a KB com os docs base + o código-fonte do repo, idempotente.
// Superfície fina sobre a API de `kb/` para dar contexto base aos agentes (DIM-18/DIM-30).
//
// Uso:
//   node kb/seed.mjs [--db arquivo.db] [--fake]
//
// - Provider default = real (transformers); --fake (ou KB_FAKE_EMBEDDINGS) usa o fake.
// - Idempotente: cada source é removida por `source` (deleteBySource) antes de reingerir,
//   então rodar 2x não duplica.
// - Docs base: kind='doc' (ver DOCS abaixo).
// - Código-fonte (DIM-30): kind='code' — `kb/*.{js,mjs}` (exceto *.test.js/node_modules/*.db)
//   e `.claude/**/*.md` (exceto `.claude/worktrees/**`). Dá ao recall de execution padrões reais.
// - Todo chunk entra com source=<caminho relativo à raiz>, stage=null, ticketId='REPO'.
// - Arquivo ausente/grande demais/binário: avisa em stderr e pula (não falha).
// - SOMENTE JSON vai para stdout; erros vão para stderr + exit 1.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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

// Limite de tamanho por arquivo de código (~256 KB). Acima disso, pula (evita
// arquivos gerados/binários grandes inflarem a KB). Texto-only por extensão.
const MAX_CODE_BYTES = 256 * 1024;

// Diretórios sempre excluídos do walker de código (defensivo, em qualquer nível).
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  'dist',
  'build',
  'coverage',
  'worktrees', // cobre `.claude/worktrees/**`
]);

// Raízes de código + extensões incluídas. `kb/` traz a lib; `.claude/` traz os
// prompts/skills (markdown). Caminhos relativos à RAIZ do repo.
const CODE_ROOTS = [
  { dir: 'kb', exts: ['.js', '.mjs'] },
  { dir: '.claude', exts: ['.md'] },
];

// Decide se um `source` (relativo à raiz) entra como código.
function isIncludedCode(rel, exts) {
  const segments = rel.split(path.sep);
  // Exclui se qualquer segmento de diretório for proibido.
  if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) return false;
  // Defensivo: nunca ingerir DBs nem arquivos de teste como código.
  if (rel.endsWith('.db')) return false;
  if (rel.endsWith('.test.js')) return false;
  return exts.some((ext) => rel.endsWith(ext));
}

// Coleta determinística (ordenada) das sources de código via walker nativo.
// `fs.globSync` não existe no Node 20.18.1 — usamos readdirSync recursivo.
function collectCodeSources() {
  const sources = new Set();
  for (const { dir, exts } of CODE_ROOTS) {
    const absDir = path.resolve(repoRoot, dir);
    if (!existsSync(absDir)) continue;
    let entries;
    try {
      entries = readdirSync(absDir, { recursive: true, withFileTypes: true });
    } catch (err) {
      process.stderr.write(`seed: falha ao varrer ${dir}: ${err && err.message ? err.message : err}\n`);
      continue;
    }
    for (const d of entries) {
      if (!d.isFile()) continue;
      const abs = path.join(d.parentPath, d.name);
      const rel = path.relative(repoRoot, abs);
      if (isIncludedCode(rel, exts)) sources.add(rel);
    }
  }
  return [...sources].sort();
}

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

  // Ingesta uma única source (idempotente), reusando o mesmo padrão para doc/code.
  async function ingestSource(rel, kind) {
    const abs = path.resolve(repoRoot, rel);
    if (!existsSync(abs)) {
      process.stderr.write(`seed: ${kind} ausente, pulando: ${rel}\n`);
      return;
    }
    const size = statSync(abs).size;
    if (size > MAX_CODE_BYTES) {
      process.stderr.write(`seed: ${kind} grande demais (${size}B > ${MAX_CODE_BYTES}B), pulando: ${rel}\n`);
      return;
    }
    const text = readFileSync(abs, 'utf8');
    // Idempotência: limpa o que existia para esta source antes de reingerir.
    mem.deleteBySource(rel);
    const { chunks } = await mem.ingest({
      ticketId: 'REPO',
      stage: null,
      kind,
      source: rel,
      text,
    });
    seeded.push({ source: rel, kind, chunks });
    total += chunks;
  }

  for (const rel of DOCS) await ingestSource(rel, 'doc');
  for (const rel of collectCodeSources()) await ingestSource(rel, 'code');

  console.log(JSON.stringify({ seeded, total }));
} catch (err) {
  process.stderr.write(`seed: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  if (mem) mem.close();
}
