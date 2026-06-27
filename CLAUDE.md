# Esteira de Tasks v3 (Loop Engineering)

Pipeline autônomo onde tickets do Linear fluem por estações, cada uma com um agente
responsável. Inspirado em "Loop Engineering": você não dá prompt ticket-a-ticket —
você projeta o sistema (a esteira) que faz isso.

**O Linear é o board / fonte de verdade.** Uma base de conhecimento vetorial local
(`kb/`) dá contexto e memória aos agentes. Nenhum serviço próprio a deployar.

## Como funciona

- **Board**: projeto **Auto Lane** no Linear (time `Lane`/`DIM`). Identifique **por ID** —
  os nomes podem mudar (ver IDs abaixo).
- **Colunas (status)**: `Todo` → `In Progress` → `To Review` → `Done` (+ `Backlog`, `Canceled`).
- **Estações**: dentro de `In Progress`, um label do grupo `stage` diz a sub-estação (understand/execution/review/blocked).
- **Driver**: o skill `/esteira` faz UMA varredura. `/loop /esteira` roda em loop (heartbeat).
- **Gate humano**: só a **saída** (`To Review` → `Done`). A entrada é automática.
- **Auto-sequência (pull):** a esteira é WIP=1 e **se mantém ocupada**. Sempre que não há
  ticket ativo e existe um `Todo` elegível (todos os `blockedBy` já **integrados** = em
  `To Review` ou `Done`), ela puxa sozinha o próximo — **sem** esperar gate humano de entrada.
  Tickets em `To Review`/`blocked` esperam humano mas não ocupam a vaga. Detalhe no skill `/esteira`.
- **Um driver por vez:** cada sweep adquire um lock de exclusão mútua
  (`.claude/esteira.lock.d/`, `mkdir` atômico, TTL 30min) antes de tocar no Linear e o
  libera no fim. Dois `/esteira` simultâneos não furam o WIP=1 — o 2º aborta silenciosamente.

## Máquina de estados

**Fonte de verdade = ARTEFATOS (comentários), não o label.** O label `stage:*` é só
espelho. O driver deriva o estágio dos comentários do ticket, então um label perdido
ou errado nunca causa regressão/retrabalho. "Sem label" ≠ "novo"; novo = sem artefato.

Estágio derivado (mais recente → mais antigo):
```
Kick-back (⛔)          → invalida artefatos < createdAt do kick-back; reverte merge + reabre em understand (cap 2 → blocked)
Review APPROVED        → integra + move p/ status `To Review` (gate humano)
Review REJECTED (<3)   → execution  | (>=3) → blocked
Work Log SUCCESS       → review
Work Log FAILED        → blocked
Context Spec (s/ block)→ execution  | (c/ blockers) → blocked
nenhum artefato        → understand (entrada)
```

Fluxo: `Todo ─(auto)─► In Progress` → understand → execution → review →
(APPROVED, auto: merge + status) `To Review` ─(humano)─► `Done`. Entrada automática; gate humano só na saída.

Tentativas = nº de comentários `## 🔍 Review` REJECTED. Limite: 3 → `blocked`.
**Base de branch para review/merge: `production`.** Executor commita em `esteira/<TICKET-ID>`.

| Evento | Ação da esteira |
|---|---|
| Review APPROVED | **auto, na mesma varredura:** merge `esteira/<TICKET-ID>` → `production` (idempotente) **e move o ticket p/ `To Review`**. A fila **não** espera você. |
| você move `To Review` → `Done` | só fecha o ticket (o merge já ocorreu) |
| você reprova: move `To Review`/`Done` → `Todo` + comenta `## ⛔ Kick-back: <motivo>` | **auto (idempotente):** o kick-back invalida os artefatos anteriores (createdAt < o dele), reverte o merge em `production` (`git revert -m 1`), e reabre o ticket em `In Progress`/`understand` passando o `<motivo>` ao context-builder. Mover status não basta — o artefato é a verdade. Anti-loop: 2 kick-backs → `blocked`. |

**Autonomia & WIP=1:** a esteira roda o épico inteiro sozinha, empilhando os tickets em
`To Review` p/ você validar quando quiser. Ela só para por **bloqueio real** (`blocked`) ou
por não haver `Todo` elegível. Invariante: **uma única task ativa por vez**.

## Handoffs (artefatos como comentários no ticket)

Cada estação grava seu resultado como comentário no ticket, com header padrão:
- `## 🧭 Context Spec` — escopo, arquivos afetados, abordagem, critérios de aceite, plano de testes.
- `## 🔧 Work Log` — o que o executor fez, branch/diff, testes rodados.
- `## 🔍 Review` — veredito (APPROVED/REJECTED) + justificativa contra os critérios.

## Base de conhecimento (`kb/`) — memória dos agentes

A `kb/` é a camada de memória vetorial local (sqlite-vec + embeddings local-first via
`transformers.js`), portada da v2. É uma biblioteca local — um arquivo `.db`
(`kb.db`, gitignored), **sem serviço**.

O driver usa a KB em dois momentos por ticket (read + write):
- **Recall** (antes de acionar a estação): consulta a KB e injeta um bloco
  `## 📚 Memória relevante` no prompt do agente. *(wiring em DIM-19)*
- **Ingest** (depois de postar o artefato no Linear): grava Context Spec / Work Log /
  Review na KB, com tags `kind`/`stage`/`source`, de forma idempotente. *(wiring em DIM-20)*

> CLIs `kb/recall.mjs` e `kb/ingest.mjs` são a superfície que o driver chama (DIM-17).
> Enquanto o wiring não chega, a esteira roda só sobre o Linear (como a v1).

## IDs do Linear (coordenadas da esteira)

**Team e Project são âncoras estáveis — sempre use o ID.** Já os **status e labels são
resolvidos por NOME a cada sweep** (passo 0 do skill `/esteira`, via `list_issue_statuses`
+ `list_issue_labels`): a tabela de IDs abaixo é apenas **cache/fallback**. Se o board for
reordenado/recriado os IDs mudam, e o driver passa a usar os IDs ao vivo (reportando a
divergência) sem quebrar o sweep.

> **Nomes canônicos = contrato (não renomeie).** As colunas `Todo` / `In Progress` /
> `To Review` / `Done` / `Canceled` e os labels `stage:understand` / `stage:execution` /
> `stage:review` / `stage:blocked` são resolvidos por esses nomes exatos a cada sweep.
> Renomear qualquer um deles quebra a resolução: status canônico ausente **aborta o sweep**;
> label `stage:*` ausente cai no ID hardcoded abaixo + warning.

- Team (atual: "Lane", key DIM): `3c0058ed-759f-4678-b219-4d34d0f533d7`
- Project (atual: "Auto Lane"): `9a2f315c-8def-4698-ba9a-8d0a680cda13`
- Épico v3: **DIM-14**

Status — **cache/fallback (resolvido por nome a cada sweep)** (⚠️ "To Review" reusou o ID do antigo "Done"; "Done" agora é um ID novo):
- Todo: `c7b52570-af37-4d8e-abd3-95d927cae20c`
- In Progress: `e26d59a8-f02e-4959-ae24-ee57e81f4534`
- **To Review: `8f89ea97-e4c4-4625-a29a-56aab536363f`** (era o ID do antigo "Done")
- **Done (novo): `be50bf53-88ac-4021-8bdf-774695cff007`**
- Canceled: `74f37c47-98d8-47a8-a7e7-f7936f4bc207`

Labels — **cache/fallback (resolvido por nome a cada sweep)** (grupo `stage` = `9e921002-79e5-4435-92af-b2f42025b724`) — sub-estações de `In Progress`:
- stage:understand: `c1e0dfb5-423f-49c5-915b-686c025b1dd7`
- stage:execution: `58c3331f-3539-4e5b-b13f-16a9601aea0b`
- stage:review: `e948cf81-3414-4c55-a62d-c7c9192e5db7`
- stage:blocked: `649682c6-fec8-400b-8760-5453ea25eaae`
- *(stage:sign-off `b862a7e9-0150-4159-8998-3d70eff5555b` — **deprecado**: substituído pelo status `To Review`.)*

## Como rodar

**1. Preparar a memória (`kb/`) — uma vez:**

```bash
cd kb && npm install            # better-sqlite3 + sqlite-vec (uma vez)
node seed.mjs                    # popula kb.db com os docs do repo (provider real)
node seed.mjs --fake           # ...ou offline (provider fake, sem baixar modelo)
```

`seed.mjs` cria/popula o `kb.db` (gitignored) **ancorado na raiz do repo** (default
resolvido pelo próprio script, independente do CWD) — o MESMO arquivo que recall/ingest
usam por padrão (passo 3). Idempotente.

**2. Rodar a esteira:**

- Uma passada: `/esteira`
- Em loop: `/loop /esteira` (sem intervalo = auto-ritmado) ou `/loop 15m /esteira`

**3. Recall + ingest no MESMO `kb.db` default.** O driver chama `kb/recall.mjs` (READ →
injeta `## 📚 Memória relevante` no prompt) e `kb/ingest.mjs` (WRITE) **sem** `--db`:
ambos resolvem `kb.db` **ancorado na raiz do repo** (independente do CWD). Não passe
`--db` (ver `d.0`/`d.1` no SKILL).

**Smoke (evidência offline de recall + ingest):**

```bash
cd kb && KB_FAKE_EMBEDDINGS=1 node e2e_smoke.mjs   # bloco de memória + antes/depois
cd kb && KB_FAKE_EMBEDDINGS=1 npm test             # suíte completa, offline
```
