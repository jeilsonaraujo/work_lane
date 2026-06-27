// Ingest CLI: reads text from stdin, ingests into the KB and prints {chunks, ids} as JSON.
// Thin surface over the `kb/` API for the pipeline driver (WLN-17).
//
// Usage:
//   echo "text" | node kb/ingest.mjs --ticket ID [--stage S] [--kind K] \
//        [--source SRC] [--db file.db] [--fake]
//
// - --ticket is REQUIRED.
// - Default provider = real (transformers); --fake (or KB_FAKE_EMBEDDINGS) uses the fake.
// - empty stdin → {chunks:0, ids:[]} (not an error).
// - ONLY JSON goes to stdout; errors go to stderr + exit 1.
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

const { values } = parseArgs({
  options: {
    ticket: { type: 'string' },
    stage: { type: 'string' },
    kind: { type: 'string' },
    source: { type: 'string' },
    db: { type: 'string', default: DEFAULT_DB },
    fake: { type: 'boolean', default: false },
  },
});

if (!values.ticket) {
  process.stderr.write('ingest: --ticket is required\n');
  process.exit(1);
}

const useFake = values.fake || Boolean(process.env.KB_FAKE_EMBEDDINGS);

// Reads the whole stdin until EOF.
let text = '';
for await (const chunk of process.stdin) text += chunk;

let mem;
try {
  const provider = createProvider(useFake ? 'fake' : 'transformers');
  mem = openMemory(values.db, { provider });
  const { chunks, ids } = await mem.ingest({
    ticketId: values.ticket,
    stage: values.stage ?? null,
    kind: values.kind ?? null,
    source: values.source ?? null,
    text,
  });
  console.log(JSON.stringify({ chunks, ids }));
} catch (err) {
  process.stderr.write(`ingest: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
} finally {
  if (mem) mem.close();
}
