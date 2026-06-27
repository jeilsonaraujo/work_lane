// CLI de recall: consulta a KB e imprime os top-k chunks como JSON em stdout.
// Superfície fina sobre a API de `kb/` para o driver da esteira (DIM-17).
//
// Uso:
//   node kb/recall.mjs "<query>" [--ticket ID] [--stage S] [--kind K] [--k N] \
//        [--db arquivo.db] [--fake]
//
// - Provider default = real (transformers); --fake (ou KB_FAKE_EMBEDDINGS) usa o fake.
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
    k: { type: 'string', default: '5' },
    db: { type: 'string', default: DEFAULT_DB },
    fake: { type: 'boolean', default: false },
  },
});

const queryText = positionals[0];
if (queryText === undefined || queryText === '') {
  process.stderr.write('recall: query posicional <query> é obrigatória\n');
  process.exit(1);
}

const useFake = values.fake || Boolean(process.env.KB_FAKE_EMBEDDINGS);
const k = Number(values.k);
if (!Number.isFinite(k) || k <= 0) {
  process.stderr.write(`recall: --k inválido: ${values.k}\n`);
  process.exit(1);
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
  const results = await mem.query(queryText, { filter, k });
  console.log(JSON.stringify(results));
} catch (err) {
  process.stderr.write(`recall: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  if (mem) mem.close();
}
