# Esteira de Tasks v3 (Loop Engineering)

Pipeline autônomo onde tickets do Linear fluem por estações, cada uma com um agente
responsável. Inspirado em "Loop Engineering": você não dá prompt ticket-a-ticket —
você projeta o sistema (a esteira) que faz isso.

**O Linear é o board / fonte de verdade.** Uma base de conhecimento vetorial local
(`kb/`) dá contexto e memória aos agentes. Nenhum serviço próprio a deployar.

## Como funciona

- **Board**: projeto **Mobile App** no Linear (workspace `dimenso`, time `Dimenso`/`DIM`).
- **Estações**: o status `In Progress` + um label do grupo `stage` dizem em que estação o ticket está.
- **Driver**: o skill `/esteira` faz UMA varredura. `/loop /esteira` roda em loop (heartbeat).
- **Gate humano**: só a **saída** (`stage:sign-off` → `Done`). A entrada é automática.
- **Auto-sequência (pull):** a esteira é WIP=1 e **se mantém ocupada**. Sempre que não há
  ticket ativo e existe um `Todo` elegível (todos os `blockedBy` em `Done`), ela puxa sozinha
  o próximo — **sem** esperar gate humano de entrada. Tickets em `sign-off`/`blocked` esperam
  humano mas não ocupam a vaga. Detalhe no skill `/esteira`.

## Máquina de estados

**Fonte de verdade = ARTEFATOS (comentários), não o label.** O label `stage:*` é só
espelho. O driver deriva o estágio dos comentários do ticket, então um label perdido
ou errado nunca causa regressão/retrabalho. "Sem label" ≠ "novo"; novo = sem artefato.

Estágio derivado (mais recente → mais antigo):
```
Review APPROVED        → sign-off   (gate humano)
Review REJECTED (<3)   → execution  | (>=3) → blocked
Work Log SUCCESS       → review
Work Log FAILED        → blocked
Context Spec (s/ block)→ execution  | (c/ blockers) → blocked
nenhum artefato        → understand (entrada)
```

Fluxo: `Todo ─(auto)─► In Progress` → understand → execution → review →
(APPROVED) sign-off ─(humano)─► `Done`. Entrada automática (auto-sequência); gate humano só na saída.

Tentativas = nº de comentários `## 🔍 Review` REJECTED. Limite: 3 → `blocked`.
**Base de branch para review/merge: `production`.** Executor commita em `esteira/<TICKET-ID>`.

| Evento | Ação da esteira |
|---|---|
| Review APPROVED (→ `sign-off`) | **auto:** merge `esteira/<TICKET-ID>` → `production` (idempotente); ticket fica em `sign-off` p/ validação assíncrona. A fila **não** espera você. |
| você move `sign-off` → `Done` | só fecha o ticket (o merge já ocorreu) |
| você move um ticket → `Todo` (achou problema) | kick-back: requer **reverter o merge** + invalidar os artefatos do ticket (mover status não basta — artefato é a verdade). *A refinar.* |

**Autonomia & WIP=1:** a esteira roda o épico inteiro sozinha, empilhando os tickets em
`sign-off` p/ você validar quando quiser. Ela só para por **bloqueio real** (`blocked`) ou
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

- Team Dimenso: `3c0058ed-759f-4678-b219-4d34d0f533d7`
- Project Mobile App: `9a2f315c-8def-4698-ba9a-8d0a680cda13`
- Épico v3: **DIM-14**

Status:
- Todo: `c7b52570-af37-4d8e-abd3-95d927cae20c`
- In Progress: `e26d59a8-f02e-4959-ae24-ee57e81f4534`
- Done: `8f89ea97-e4c4-4625-a29a-56aab536363f`
- Canceled: `74f37c47-98d8-47a8-a7e7-f7936f4bc207`

Labels (grupo `stage` = `9e921002-79e5-4435-92af-b2f42025b724`):
- stage:understand: `c1e0dfb5-423f-49c5-915b-686c025b1dd7`
- stage:execution: `58c3331f-3539-4e5b-b13f-16a9601aea0b`
- stage:review: `e948cf81-3414-4c55-a62d-c7c9192e5db7`
- stage:sign-off: `b862a7e9-0150-4159-8998-3d70eff5555b`
- stage:blocked: `649682c6-fec8-400b-8760-5453ea25eaae`

## Como rodar

- Uma passada: `/esteira`
- Em loop: `/loop /esteira` (sem intervalo = auto-ritmado) ou `/loop 15m /esteira`
