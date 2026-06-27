// CLI de recall: consulta a KB e imprime os top-k chunks como JSON em stdout.
// Superfície fina sobre a API de `kb/` para o driver da esteira (DIM-17).
//
// Uso:
//   node kb/recall.mjs "<query>" [--ticket ID] [--stage S] [--kind K] [--k N] \
//        [--db arquivo.db] [--fake]
//   node kb/recall.mjs --exact --ticket ID --kind K [...]   (sem query posicional)
//
// - Provider default = real (transformers); --fake (ou KB_FAKE_EMBEDDINGS) usa o fake.
// - --exact: fetch direto por metadado (artefato inteiro, ordenado por source,
//   chunk_index), SEM KNN/embedding. A query posicional é opcional sob --exact.
// - SOMENTE JSON vai para stdout (array de chunks); erros vão para stderr + exit 1.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { openMemory } = require('./index.js');
const { createProvider } = require('./embeddings.js');

// kb.db default ancorado na RAIZ do repo (script vive em kb/, então '..' = raiz),
// não no CWD — assim recall/ingest convergem no MESMO DB de qualquer diretório.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '..', 'kb.db');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ticket: { type: 'string' },
    stage: { type: 'string' },
    kind: { type: 'string' },
    source: { type: 'string' },
    // SEM default: '5'. Sob --exact, ausência de --k = "sem LIMIT" (artefato
    // inteiro). No caminho query, a ausência cai no default k=5 lá embaixo.
    k: { type: 'string' },
    db: { type: 'string', default: DEFAULT_DB },
    fake: { type: 'boolean', default: false },
    exact: { type: 'boolean', default: false },
  },
});

// Sob --exact (fetch direto por metadado), a query posicional é opcional.
const queryText = positionals[0];
if (!values.exact && (queryText === undefined || queryText === '')) {
  process.stderr.write('recall: query posicional <query> é obrigatória\n');
  process.exit(1);
}

const useFake = values.fake || Boolean(process.env.KB_FAKE_EMBEDDINGS);

// --k é opcional: só vira número (e é validado) quando o usuário o passa.
// Ausente: `undefined` (significa "sem limite" no fetch; default k=5 no query).
let k;
if (values.k != null) {
  k = Number(values.k);
  if (!Number.isFinite(k) || k <= 0) {
    process.stderr.write(`recall: --k inválido: ${values.k}\n`);
    process.exit(1);
  }
}

// Filtro montado só com as chaves presentes, em snake_case (mapeando --ticket).
const filter = {};
if (values.ticket !== undefined) filter.ticket_id = values.ticket;
if (values.stage !== undefined) filter.stage = values.stage;
if (values.kind !== undefined) filter.kind = values.kind;
if (values.source !== undefined) filter.source = values.source;

let mem;
try {
  const provider = createProvider(useFake ? 'fake' : 'transformers');
  mem = openMemory(values.db, { provider });
  const results = values.exact
    // --exact: repassa k SÓ se explícito; ausente ⇒ sem LIMIT (artefato inteiro).
    ? mem.fetch(filter, k != null ? { k } : {})
    // query: mantém o default histórico de k=5 quando --k ausente.
    : await mem.query(queryText, { filter, k: k ?? 5 });
  console.log(JSON.stringify(results));
} catch (err) {
  process.stderr.write(`recall: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  if (mem) mem.close();
}
