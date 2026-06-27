// Seed CLI: populates the KB with the base docs + the repo source code, idempotent.
// Thin surface over the `kb/` API to give base context to the agents (WLN-18/WLN-30).
//
// Usage:
//   node kb/seed.mjs [--db file.db] [--fake]
//
// - Default provider = real (transformers); --fake (or KB_FAKE_EMBEDDINGS) uses the fake.
// - Idempotent: each source is removed by `source` (deleteBySource) before re-ingesting,
//   so running it twice does not duplicate.
// - Base docs: kind='doc' (see DOCS below).
// - Source code (WLN-30): kind='code' — `kb/*.{js,mjs}` (except *.test.js/node_modules/*.db)
//   and `.claude/**/*.md` (except `.claude/worktrees/**`). Gives the execution recall real patterns.
// - Every chunk enters with source=<path relative to root>, stage=null, ticketId='REPO'.
// - Missing/too-large/binary file: warns on stderr and skips (does not fail).
// - ONLY JSON goes to stdout; errors go to stderr + exit 1.
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

// Default kb.db anchored at the repo ROOT (not at the CWD) — the SAME DB that recall/ingest
// resolve by default, regardless of the directory from which the scripts are called.
const DEFAULT_DB = path.resolve(repoRoot, 'kb.db');

// Base repo docs, in paths relative to the ROOT. They are the `source` of the tags.
const DOCS = ['CLAUDE.md', 'README.md', 'kb/README.md'];

// Size limit per code file (~256 KB). Above that, skip (avoids
// large generated/binary files inflating the KB). Text-only by extension.
const MAX_CODE_BYTES = 256 * 1024;

// Directories always excluded from the code walker (defensive, at any level).
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  'dist',
  'build',
  'coverage',
  'worktrees', // covers `.claude/worktrees/**`
]);

// Code roots + included extensions. `kb/` brings the lib; `.claude/` brings the
// prompts/skills (markdown). Paths relative to the repo ROOT.
const CODE_ROOTS = [
  { dir: 'kb', exts: ['.js', '.mjs'] },
  { dir: '.claude', exts: ['.md'] },
];

// Decides whether a `source` (relative to root) enters as code.
function isIncludedCode(rel, exts) {
  const segments = rel.split(path.sep);
  // Exclude if any directory segment is forbidden.
  if (segments.some((seg) => EXCLUDED_DIRS.has(seg))) return false;
  // Defensive: never ingest DBs nor test files as code.
  if (rel.endsWith('.db')) return false;
  if (rel.endsWith('.test.js')) return false;
  return exts.some((ext) => rel.endsWith(ext));
}

// Deterministic (sorted) collection of the code sources via native walker.
// `fs.globSync` does not exist in Node 20.18.1 — we use recursive readdirSync.
function collectCodeSources() {
  const sources = new Set();
  for (const { dir, exts } of CODE_ROOTS) {
    const absDir = path.resolve(repoRoot, dir);
    if (!existsSync(absDir)) continue;
    let entries;
    try {
      entries = readdirSync(absDir, { recursive: true, withFileTypes: true });
    } catch (err) {
      process.stderr.write(`seed: failed to scan ${dir}: ${err && err.message ? err.message : err}\n`);
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

  // Ingests a single source (idempotent), reusing the same pattern for doc/code.
  async function ingestSource(rel, kind) {
    const abs = path.resolve(repoRoot, rel);
    if (!existsSync(abs)) {
      process.stderr.write(`seed: ${kind} missing, skipping: ${rel}\n`);
      return;
    }
    const size = statSync(abs).size;
    if (size > MAX_CODE_BYTES) {
      process.stderr.write(`seed: ${kind} too large (${size}B > ${MAX_CODE_BYTES}B), skipping: ${rel}\n`);
      return;
    }
    const text = readFileSync(abs, 'utf8');
    // Idempotency: clears whatever existed for this source before re-ingesting.
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
