// Recall CLI: queries the KB and prints the top-k chunks as JSON on stdout.
// Thin surface over the `kb/` API for the pipeline driver (WLN-17).
//
// Usage:
//   node kb/recall.mjs "<query>" [--ticket ID] [--stage S] [--kind K] [--k N] \
//        [--db file.db] [--fake]
//   node kb/recall.mjs --exact --ticket ID --kind K [...]   (no positional query)
//
// - Default provider = real (transformers); --fake (or KB_FAKE_EMBEDDINGS) uses the fake.
// - --exact: direct fetch by metadata (whole artifact, ordered by source,
//   chunk_index), WITHOUT KNN/embedding. The positional query is optional under --exact.
// - ONLY JSON goes to stdout (array of chunks); errors go to stderr + exit 1.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { openMemory } = require('./index.js');
const { createProvider } = require('./embeddings.js');

// Default kb.db anchored at the repo ROOT (script lives in kb/, so '..' = root),
// not at the CWD — this way recall/ingest converge on the SAME DB from any directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '..', 'kb.db');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ticket: { type: 'string' },
    stage: { type: 'string' },
    kind: { type: 'string' },
    source: { type: 'string' },
    // NO default: '5'. Under --exact, absence of --k = "no LIMIT" (whole
    // artifact). On the query path, absence falls into the default k=5 below.
    k: { type: 'string' },
    db: { type: 'string', default: DEFAULT_DB },
    fake: { type: 'boolean', default: false },
    exact: { type: 'boolean', default: false },
  },
});

// Under --exact (direct fetch by metadata), the positional query is optional.
const queryText = positionals[0];
if (!values.exact && (queryText === undefined || queryText === '')) {
  process.stderr.write('recall: positional <query> is required\n');
  process.exit(1);
}

const useFake = values.fake || Boolean(process.env.KB_FAKE_EMBEDDINGS);

// --k is optional: it only becomes a number (and is validated) when the user passes it.
// Absent: `undefined` (means "no limit" in fetch; default k=5 in query).
let k;
if (values.k != null) {
  k = Number(values.k);
  if (!Number.isFinite(k) || k <= 0) {
    process.stderr.write(`recall: invalid --k: ${values.k}\n`);
    process.exit(1);
  }
}

// Filter built only with the present keys, in snake_case (mapping --ticket).
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
    // --exact: passes k ONLY if explicit; absent ⇒ no LIMIT (whole artifact).
    ? mem.fetch(filter, k != null ? { k } : {})
    // query: keeps the historical default of k=5 when --k is absent.
    : await mem.query(queryText, { filter, k: k ?? 5 });
  console.log(JSON.stringify(results));
} catch (err) {
  process.stderr.write(`recall: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  if (mem) mem.close();
}
