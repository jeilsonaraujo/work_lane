# Base de conhecimento (`kb/`)

Memória/contexto semântica da esteira v3 (portada da v2, DIM-16). Base **separada e
desacoplada**: biblioteca standalone, sem serviço/MCP, usa seu próprio
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
| `providers/transformers.js` | provider real (multilíngue, `paraphrase-multilingual-MiniLM-L12-v2`), `import()` lazy do modelo |
| `chunking.js` | chunking determinístico por tamanho + overlap |
| `index.js` | `openMemory` / `createMemory` → `ingest`, `ingestBatch`, `query`, `deleteBySource` |
| `seed.mjs` | CLI que popula a KB com os docs base do repo (`kind=doc`), idempotente |
| `ingest.mjs` / `recall.mjs` | CLIs finas de escrita/leitura usadas pelo driver da esteira |
| `e2e_smoke.mjs` | smoke e2e: prova recall+ingest nos dois sentidos (memória no prompt + chunk novo) |

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

## Esquema de tags

Todo chunk carrega metadados (tags) usados no filtro híbrido do `query`/`recall`.
O esquema é fixo em todo o wiring da esteira:

| Tag | Valores | Significado |
|---|---|---|
| `kind` | `doc`, `spec`, `worklog`, `review` | tipo do conteúdo: doc do repo ou artefato de uma estação |
| `stage` | `understand`, `execution`, `review`, `sign-off`, `blocked`, ou `null` | estágio que produziu o artefato; `null` para docs do repo |
| `source` | caminho do arquivo (docs) **ou** ID do comentário do Linear (artefatos) | origem/identidade do conteúdo; chave da idempotência |
| `ticket_id` | ex.: `DIM-18`, ou `REPO` (sentinela dos docs do repo) | ticket dono do conteúdo |

- **Docs do repo** (via `seed.mjs`): `kind='doc'`, `stage=null`, `ticket_id='REPO'`,
  `source=<caminho relativo à raiz>` (ex.: `'CLAUDE.md'`, `'kb/README.md'`). O recall
  desses docs filtra por `--kind doc`.
- **Artefatos das estações** (via `ingest.mjs`): `kind ∈ {spec, worklog, review}`,
  `stage` = a estação, `source` = ID do comentário no Linear.

**Idempotência por `source`:** o próprio `Memory.ingest` remove-antes-de-inserir quando há
`source` — apaga os `chunks` + `vec_chunks` pareados daquela `source` na **mesma transação**
do insert (`source` null/ausente = sem dedup). Assim, reingerir o mesmo artefato **substitui**
em vez de duplicar. `Memory.deleteBySource(source)` continua disponível para remoção avulsa, e
o `seed.mjs` apenas **reforça** essa garantia — rodá-lo 2x não duplica.

```bash
# Popular a KB com os docs base do repo (idempotente):
node seed.mjs            # provider real (transformers)
node seed.mjs --fake     # provider fake (offline)

# Buscar só nos docs do repo:
node recall.mjs "como funciona a esteira" --kind doc
```

## Dimensão dos vetores

`EMBED_DIM` (em `db.js`, atualmente **384** = `paraphrase-multilingual-MiniLM-L12-v2`)
é a fonte de verdade única: o runner substitui `{{EMBED_DIM}}` no schema e ambos
os providers declaram `dim === EMBED_DIM`. **Trocar de modelo/dimensão** = nova
migration (`002_*.sql` com nova tabela vetorial) + **re-index** dos documentos.
Não há conversão automática entre dimensões.

O provider real default usa `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, um
modelo **multilíngue** (PT incluso) e **simétrico**: como query e passagem
compartilham o mesmo encoding, **não** é preciso prefixar os textos com
`query:`/`passage:` (ao contrário da família e5). A API `embed(texts)` trata
consulta e documento de forma indistinta.

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
Junto rodam os smokes de CLI (`cli.test.js`, `seed.test.js`) e o e2e (`e2e_smoke.test.js`).

## Smoke e2e (recall + ingest)

`e2e_smoke.mjs` é a evidência ponta-a-ponta da esteira v3 com memória, **offline** (provider
fake) sobre um `kb.db` **temp** (nunca toca o `kb.db` real). Espelha o driver:

1. **Ingest #1** — grava um Context Spec fake (memória-âncora) e imprime a contagem.
2. **Recall** — consulta a KB e **monta o bloco `## 📚 Memória relevante`** exatamente como
   o passo `d.0.3` do SKILL (`N. [ticket · kind/stage · source] (dist X)` + body trunc ~500).
   Provar que o bloco aparece = **memória injetada no prompt do agente**.
3. **Ingest #2** — grava um Work Log novo; assere que a contagem de chunks **cresceu** =
   **chunk novo na KB**.

```bash
cd kb && KB_FAKE_EMBEDDINGS=1 node e2e_smoke.mjs   # imprime o bloco + "antes=X depois=Y"
```

Sai com código ≠ 0 em qualquer erro (inclusive se a KB não crescer). O wrapper
`e2e_smoke.test.js` roda esse script via `node --test` e assere exit 0, presença do bloco e
o crescimento da contagem — entrando na suíte offline padrão.

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
