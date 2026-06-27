// Manual recall with the REAL provider (transformers.js). Outside the test gate:
// downloads a model on the 1st run. Usage:
//   node kb/scripts/recall.mjs "my query" [file.db]
//
// Ingests a few example texts and runs a semantic query, just to
// validate the end-to-end pipeline with real embeddings.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openMemory } = require('../index.js');
const { createProvider } = require('../embeddings.js');

const queryText = process.argv[2] || 'how does the memory layer work?';
const file = process.argv[3] || ':memory:';

const provider = createProvider('transformers');
const mem = openMemory(file, { provider });

await mem.ingestBatch([
  { ticketId: 'DEMO', kind: 'doc', text: 'The memory uses sqlite-vec over better-sqlite3.' },
  { ticketId: 'DEMO', kind: 'doc', text: 'Embeddings are local-first via transformers.js.' },
  { ticketId: 'DEMO', kind: 'doc', text: 'The chunking is deterministic by size and overlap.' },
]);

const results = await mem.query(queryText, { k: 3 });
console.log(`\nQuery: ${queryText}\n`);
for (const r of results) {
  console.log(`[${r.distance.toFixed(4)}] ${r.body}`);
}
mem.close();
