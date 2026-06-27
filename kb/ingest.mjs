// CLI de ingest: lê texto do stdin, ingere na KB e imprime {chunks, ids} como JSON.
// Superfície fina sobre a API de `kb/` para o driver da esteira (DIM-17).
//
// Uso:
//   echo "texto" | node kb/ingest.mjs --ticket ID [--stage S] [--kind K] \
//        [--source SRC] [--db arquivo.db] [--fake]
//
// - --ticket é OBRIGATÓRIO.
// - Provider default = real (transformers); --fake (ou KB_FAKE_EMBEDDINGS) usa o fake.
// - stdin vazio → {chunks:0, ids:[]} (não é erro).
// - SOMENTE JSON vai para stdout; erros vão para stderr + exit 1.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { openMemory } = require('./index.js');
const { createProvider } = require('./embeddings.js');

const { values } = parseArgs({
  options: {
    ticket: { type: 'string' },
    stage: { type: 'string' },
    kind: { type: 'string' },
    source: { type: 'string' },
    db: { type: 'string', default: 'kb.db' },
    fake: { type: 'boolean', default: false },
  },
});

if (!values.ticket) {
  process.stderr.write('ingest: --ticket é obrigatório\n');
  process.exit(1);
}

const useFake = values.fake || Boolean(process.env.KB_FAKE_EMBEDDINGS);

// Lê o stdin inteiro até EOF.
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
