# WorkLane — Esteira v3

Pipeline autônomo (Loop Engineering) onde tickets do **Linear** fluem por estações,
cada uma com um agente responsável. O Linear é o board / fonte de verdade; uma
**base de conhecimento vetorial local** (`kb/`) dá contexto e memória aos agentes.

Épico no Linear: **DIM-14**.

## Por que v3 (e não v2)

A v2 (DIM-10) tentou substituir o Linear por um serviço local próprio. Isso exige
deploy/manutenção de um sistema próprio e impede acompanhar o board de qualquer lugar.
A v3 **mantém o Linear como board** e só reaproveita o pedaço que valia da v2 — a
**memória vetorial local-first** — como biblioteca local (um arquivo `.db`, sem serviço).

## Arquitetura

```
   Linear (board / fonte de verdade)
        │  tickets + comentários (artefatos)
        ▼
   /esteira (driver)  ──recall──►  kb/ (memória vetorial local)
        │                ◄─ingest──┘
        ▼
   estações: understand → execution → review → To Review
   (context-builder)  (executor)   (reviewer)   (gate humano)
```

- **Board:** projeto **Auto Lane** no Linear (identifique por ID — o nome pode mudar).
  Colunas: `Todo → In Progress → To Review → Done`. Estágio derivado dos artefatos
  (comentários), não do label. Ver `CLAUDE.md` e `.claude/skills/esteira/SKILL.md`.
- **Memória (`kb/`):** sqlite-vec + embeddings local-first (`transformers.js`),
  portada da v2. O driver consulta (recall) antes de cada estação e grava (ingest)
  cada artefato. *(Chega nos tickets DIM-16…DIM-20.)*

## Branch model

- Base de branch: **`production`**. Executor commita em `esteira/<TICKET-ID>`.
- Review APROVADA → a esteira integra (merge → `production`) e move p/ `To Review`.
  Gate humano só na saída: você valida em `To Review` e move → `Done`.

## Como rodar

**1. Preparar a memória (`kb/`) — uma vez:**

```bash
cd kb && npm install            # better-sqlite3 + sqlite-vec (uma vez)
node seed.mjs                    # popula kb.db com os docs do repo (provider real)
node seed.mjs --fake            # ...ou offline (provider fake, sem baixar modelo)
```

`seed.mjs` cria/popula o `kb.db` (gitignored) **ancorado na raiz do repo** (o default é
resolvido pelo próprio script, independente do CWD) — é o mesmo arquivo que recall e
ingest usam por padrão (ver passo 3). É idempotente: rodar 2× não duplica.

**2. Rodar a esteira:**

```
/esteira            # uma passada (uma varredura do board)
/loop /esteira      # heartbeat (auto-ritmado) — ou /loop 15m /esteira
```

**3. Recall + ingest usam o MESMO `kb.db` default.** O driver chama `kb/recall.mjs`
(READ, antes da estação → injeta o bloco `## 📚 Memória relevante` no prompt) e
`kb/ingest.mjs` (WRITE, depois do artefato) **sem** `--db` — ambos resolvem o default
`kb.db` **ancorado na raiz do repo** (independente do CWD). Não passe `--db`: apontar
para outro arquivo faria a memória escrita nunca ser lida de volta.

**Smoke (evidência offline de recall + ingest):**

```bash
cd kb && KB_FAKE_EMBEDDINGS=1 node e2e_smoke.mjs   # imprime o bloco de memória + antes/depois
cd kb && KB_FAKE_EMBEDDINGS=1 npm test             # suíte completa, 100% offline
```

> Bootstrap inicial em DIM-15. Os demais tickets do épico a própria esteira executa (dogfood).
