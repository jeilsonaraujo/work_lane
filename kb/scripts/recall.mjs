// Recall manual com o provider REAL (transformers.js). Fora do gate de testes:
// baixa modelo na 1ª execução. Uso:
//   node kb/scripts/recall.mjs "minha consulta" [arquivo.db]
//
// Ingesta alguns textos de exemplo e roda uma query semântica, só para
// validar o pipeline ponta-a-ponta com embeddings reais.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openMemory } = require('../index.js');
const { createProvider } = require('../embeddings.js');

const queryText = process.argv[2] || 'como funciona a camada de memória?';
const file = process.argv[3] || ':memory:';

const provider = createProvider('transformers');
const mem = openMemory(file, { provider });

await mem.ingestBatch([
  { ticketId: 'DEMO', kind: 'doc', text: 'A memória usa sqlite-vec sobre better-sqlite3.' },
  { ticketId: 'DEMO', kind: 'doc', text: 'Embeddings são local-first via transformers.js.' },
  { ticketId: 'DEMO', kind: 'doc', text: 'O chunking é determinístico por tamanho e overlap.' },
]);

const results = await mem.query(queryText, { k: 3 });
console.log(`\nConsulta: ${queryText}\n`);
for (const r of results) {
  console.log(`[${r.distance.toFixed(4)}] ${r.body}`);
}
mem.close();
