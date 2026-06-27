# Base de conhecimento (`kb/`)

Memória/contexto semântica da esteira v3 (portada da v2, DIM-16). Base **separada e
desacoplada**: não importa `registry` nem nenhum serviço/MCP, usa seu próprio
arquivo `.db` (default `kb.db`, gitignored).

Stack: **better-sqlite3** + **sqlite-vec** (tabela virtual `vec0`) + embeddings
**local-first** (`transformers.js`), com provider injetável.

## Componentes

| Arquivo | Papel |
|---|---|
| `db.js` | abre SQLite, carrega sqlite-vec (`sqliteVec.load`), pragmas; exporta `EMBED_DIM` |
| `migrate.js` | runner de migrations idempotente sobre `schema/` |
| `schema/001_init.sql` | tabela virtual `vec_chunks` + `chunks` (metadados) + `schema_migrations` + índices |
| `embeddings.js` | contrato do provider + `FakeEmbeddingProvider` + factory `createProvider` |
| `providers/transformers.js` | provider real (bge-small), `import()` lazy do modelo |
| `chunking.js` | chunking determinístico por tamanho + overlap |
| `index.js` | `openMemory` / `createMemory` → `ingest`, `ingestBatch`, `query` |

## Uso

```js
const { openMemory } = require('./index');

// Default usa o provider fake (offline). Para o provider real, injete:
//   const { createProvider } = require('./embeddings');
//   const mem = openMemory('kb.db', { provider: createProvider('transformers') });
const mem = openMemory('kb.db');

await mem.ingest({
  ticketId: 'DIM-16',
  stage: 'execution',
  kind: 'spec',
  source: 'context-spec',
  text: 'texto longo do artefato...',
});

const hits = await mem.query('busca semântica', {
  filter: { ticket_id: 'DIM-16', stage: 'execution' }, // filtro híbrido opcional
  k: 5,
});
// hits: [{ ticket_id, stage, kind, source, body, chunk_index, distance }] ordenado por distance asc
```

## Dimensão dos vetores

`EMBED_DIM` (em `db.js`, atualmente **384** = bge-small) é a fonte de verdade
única: o runner substitui `{{EMBED_DIM}}` no schema e ambos os providers
declaram `dim === EMBED_DIM`. **Trocar de modelo/dimensão** = nova migration
(`002_*.sql` com nova tabela vetorial) + **re-index** dos documentos. Não há
conversão automática entre dimensões.

## Troca de provider

`query`/`ingest` recebem o provider via construtor (`{ provider }`). Qualquer
objeto `{ name, dim, embed(texts) => Promise<Float32Array[]> }` serve:

- `createProvider('fake')` — determinístico, offline, usado nos **testes**.
- `createProvider('transformers')` — local-first; faz `import()` lazy do modelo
  só na 1ª chamada a `embed()`. **Nenhum teste** carrega esse provider.
- **Voyage** (futuro) — basta um novo provider com o mesmo contrato.

`@huggingface/transformers` é dependência **opcional**: ausência não quebra
`npm install`/`npm test`; a 1ª chamada ao provider real é que falha com mensagem
clara.

## Testes (offline)

```bash
cd kb && npm install && npm test
```

A suíte (`memory.test.js`, `node --test`) roda 100% offline com o provider fake:
migrations + idempotência, carga da extensão (`vec_version()`), chunking,
determinismo do fake, ingestão, query por similaridade e híbrida, ranking por
`distance`, e um teste que garante que `transformers.js` **não** foi carregado.

## Recall manual (provider real)

Fora do gate de testes (baixa modelo na 1ª vez):

```bash
node scripts/recall.mjs "como funciona a memória?"
```

## LanceDB (futuro)

O MVP usa sqlite-vec por rodar offline e alinhar com a stack local. Migrar para
**LanceDB** é uma evolução possível se a escala/recursos de indexação exigirem —
o contrato de `Memory` (`ingest`/`query`) isola o store, e o provider de
embedding já é desacoplado.
