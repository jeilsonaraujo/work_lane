# Knowledge base (`kb/`)

Semantic memory/context for the agents (WLN-16). A **separate and decoupled** base:
a standalone library, with no service/MCP, using its own `.db` file
(default `kb.db`, gitignored).

Stack: **better-sqlite3** + **sqlite-vec** (virtual table `vec0`) + **local-first**
embeddings (`transformers.js`), with an injectable provider.

## Components

| File | Role |
|---|---|
| `db.js` | opens SQLite, loads sqlite-vec (`sqliteVec.load`), pragmas; exports `EMBED_DIM` |
| `migrate.js` | idempotent migration runner over `schema/` |
| `schema/001_init.sql` | virtual table `vec_chunks` + `chunks` (metadata) + `schema_migrations` + indexes |
| `embeddings.js` | provider contract + `FakeEmbeddingProvider` + `createProvider` factory |
| `providers/transformers.js` | real provider (multilingual, `paraphrase-multilingual-MiniLM-L12-v2`), lazy `import()` of the model |
| `chunking.js` | deterministic chunking by size + overlap |
| `index.js` | `openMemory` / `createMemory` → `ingest`, `ingestBatch`, `query`, `deleteBySource` |
| `seed.mjs` | CLI that populates the KB with the base docs (`kind=doc`) **and the repo source code** (`kind=code`), idempotent |
| `ingest.mjs` / `recall.mjs` | thin write/read CLIs used by the driver |
| `e2e_smoke.mjs` | e2e smoke: proves recall+ingest in both directions (memory in the prompt + new chunk) |

## Usage

```js
const { openMemory } = require('./index');

// Default uses the fake provider (offline). For the real provider, inject it:
//   const { createProvider } = require('./embeddings');
//   const mem = openMemory('kb.db', { provider: createProvider('transformers') });
const mem = openMemory('kb.db');

await mem.ingest({
  ticketId: 'WLN-16',
  stage: 'execution',
  kind: 'spec',
  source: 'context-spec',
  text: 'long artifact text...',
});

const hits = await mem.query('semantic search', {
  filter: { ticket_id: 'WLN-16', stage: 'execution' }, // optional hybrid filter
  k: 5,
});
// hits: [{ ticket_id, stage, kind, source, body, chunk_index, distance }] ordered by distance asc
```

## Tag schema

Every chunk carries metadata (tags) used in the hybrid filter of `query`/`recall`.
The schema is fixed across all wiring:

| Tag | Values | Meaning |
|---|---|---|
| `kind` | `doc`, `code`, `spec`, `worklog`, `review` | content type: repo doc, repo source code, or a station artifact |
| `stage` | `understand`, `execution`, `review`, `sign-off`, `blocked`, or `null` | stage that produced the artifact; `null` for repo docs |
| `source` | file path (docs) **or** Linear comment ID (artifacts) | origin/identity of the content; idempotency key |
| `ticket_id` | e.g. `WLN-18`, or `REPO` (sentinel for repo docs) | ticket that owns the content |

- **Repo docs** (via `seed.mjs`): `kind='doc'`, `stage=null`, `ticket_id='REPO'`,
  `source=<path relative to the root>` (e.g. `'CLAUDE.md'`, `'kb/README.md'`). Recall
  of these docs filters by `--kind doc`.
- **Repo source code** (via `seed.mjs`): `kind='code'`, `stage=null`,
  `ticket_id='REPO'`, `source=<path relative to the root>` (e.g. `'kb/index.js'`,
  `'.claude/skills/lane/SKILL.md'`). Gives the execution recall real code
  patterns. Recall filters by `--kind code`. **What is seeded:**
  - `kb/` → `*.js` and `*.mjs` files;
  - `.claude/` → `*.md` files (prompts/skills/agents).

  **What is NOT seeded** (walker exclusions): `node_modules/`, `.git/` and caches
  (`.cache`/`dist`/`build`/`coverage`) at any level; `*.db` files; test files
  `*.test.js`; and everything under `.claude/worktrees/**` (ephemeral worktrees). Text
  files larger than ~256 KB are skipped (binaries/generated files do not enter). The
  walker is native (`fs.readdirSync(dir, { recursive: true })` — `fs.globSync` does not
  exist on Node 20.18.1) and the source list is sorted for deterministic ingestion.
- **Station artifacts** (via `ingest.mjs`): `kind ∈ {spec, worklog, review}`,
  `stage` = the station, `source` = the Linear comment ID.

**Idempotence by `source`:** `Memory.ingest` itself does delete-before-insert when a
`source` is present — it removes the paired `chunks` + `vec_chunks` of that `source` in the
**same transaction** as the insert (`source` null/absent = no dedup). So reingesting the same
artifact **replaces** instead of duplicating. `Memory.deleteBySource(source)` remains available
for ad-hoc removal, and `seed.mjs` only **reinforces** this guarantee — running it twice does
not duplicate.

```bash
# Populate the KB with the base docs + the repo source code (idempotent):
node seed.mjs            # real provider (transformers)
node seed.mjs --fake     # fake provider (offline)

# Search only the repo docs:
node recall.mjs "how the pipeline works" --kind doc

# Search patterns in the seeded source code:
node recall.mjs "openMemory ingest deleteBySource" --kind code
```

## Vector dimension

`EMBED_DIM` (in `db.js`, currently **384** = `paraphrase-multilingual-MiniLM-L12-v2`)
is the single source of truth: the runner substitutes `{{EMBED_DIM}}` in the schema and
both providers declare `dim === EMBED_DIM`. **Switching model/dimension** = a new
migration (`002_*.sql` with a new vector table) + a **re-index** of the documents.
There is no automatic conversion between dimensions.

### Distance metric (cosine via L2-normalized)

The search uses the **L2 (Euclidean)** distance of `vec0` (sqlite-vec default; without
`distance_metric=`). Since the embeddings are **L2-normalized** (norm ≈ 1, via
`normalize()` in `embeddings.js`, applied by both providers), ranking by L2 is
**monotonically equivalent to cosine**: for unit vectors `L2² = 2·(1 − cos)`, so
"smaller L2" == "greater cosine similarity". In other words, we order by cosine in
practice without changing the DDL or needing a migration.

The default real provider uses `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, a
**multilingual** and **symmetric** model: since query and passage share the same
encoding, there is **no** need to prefix the texts with `query:`/`passage:` (unlike the
e5 family). The `embed(texts)` API treats query and document indistinctly.

## Switching provider

`query`/`ingest` receive the provider via the constructor (`{ provider }`). Any object
`{ name, dim, embed(texts) => Promise<Float32Array[]> }` works:

- `createProvider('fake')` — deterministic, offline, used in the **tests**.
- `createProvider('transformers')` — local-first; does a lazy `import()` of the model
  only on the 1st call to `embed()`. **No test** loads this provider.
- **Voyage** (future) — just a new provider with the same contract.

`@huggingface/transformers` is an **optional** dependency: its absence does not break
`npm install`/`npm test`; the 1st call to the real provider is what fails with a clear
message.

## Tests (offline)

```bash
cd kb && npm install && npm test
```

The suite (`memory.test.js`, `node --test`) runs 100% offline with the fake provider:
migrations + idempotence, extension loading (`vec_version()`), chunking, fake determinism,
ingestion, similarity and hybrid query, ranking by `distance`, and a test that ensures
`transformers.js` is **not** loaded. The CLI smokes (`cli.test.js`, `seed.test.js`) and the
e2e (`e2e_smoke.test.js`) run alongside.

### Troubleshooting: `NODE_MODULE_VERSION`

`better-sqlite3` is a **native** module: it is compiled against a specific Node version.
When switching versions (e.g. `20 → 22`), `npm test`/`seed.mjs` fail with
`Error: ... was compiled against a different Node.js version using NODE_MODULE_VERSION`.
**This is not "node missing"** — Node is installed (via nvm); only the native binary
needs to be recompiled:

```bash
cd kb && npm rebuild better-sqlite3   # recompiles for the current Node
```

The repo pins the version in `.nvmrc` (root) — run `nvm use` before installing/running to
keep the environment consistent and avoid this mismatch.

## e2e smoke (recall + ingest)

`e2e_smoke.mjs` is the end-to-end evidence of the memory, **offline** (fake provider) over a
**temp** `kb.db` (it never touches the real `kb.db`). It mirrors the driver:

1. **Ingest #1** — writes a fake Context Spec (anchor memory) and prints the count.
2. **Recall** — queries the KB and **builds the `## 📚 Relevant memory` block** exactly like
   step `d.0.3` of the SKILL (`N. [ticket · kind/stage · source] (dist X)` + body truncated ~500).
   Proving the block appears = **memory injected into the agent's prompt**.
3. **Ingest #2** — writes a new Work Log; asserts that the chunk count **grew** =
   **new chunk in the KB**.

```bash
cd kb && KB_FAKE_EMBEDDINGS=1 node e2e_smoke.mjs   # prints the block + "before=X after=Y"
```

It exits with a non-zero code on any error (including if the KB does not grow). The
`e2e_smoke.test.js` wrapper runs this script via `node --test` and asserts exit 0, the
presence of the block and the count growth — joining the standard offline suite.

## Manual recall (real provider)

Outside the test gate (downloads the model on the 1st run):

```bash
node scripts/recall.mjs "how does the memory work?"
```

## LanceDB (future)

This base uses sqlite-vec because it runs offline and aligns with the local stack.
Migrating to **LanceDB** is a possible evolution if scale/indexing resources require it —
the `Memory` contract (`ingest`/`query`) isolates the store, and the embedding provider is
already decoupled.
