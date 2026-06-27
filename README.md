# WorkLane — Esteira v3

Pipeline autônomo (Loop Engineering) onde tickets do **Linear** fluem por estações,
cada uma com um agente responsável. O Linear é o board / fonte de verdade; uma
**base de conhecimento vetorial local** (`kb/`) dá contexto e memória aos agentes.

Épico no Linear: **DIM-14**.

## Por que v3 (e não v2)

A v2 (DIM-10) tentou substituir o Linear por um serviço local (registro SQLite +
adapter MCP). Isso exige deploy/manutenção de um sistema próprio e impede acompanhar
o board de qualquer lugar. A v3 **mantém o Linear como board** e só mistura o pedaço
que valia da v2 — a **memória vetorial local-first** — como biblioteca local (um
arquivo `.db`, sem serviço).

## Arquitetura

```
   Linear (board / fonte de verdade)
        │  tickets + comentários (artefatos)
        ▼
   /esteira (driver)  ──recall──►  kb/ (memória vetorial local)
        │                ◄─ingest──┘
        ▼
   estações: understand → execution → review → sign-off
   (context-builder)  (executor)   (reviewer)   (gate humano)
```

- **Board:** projeto **Mobile App** no Linear. Estágio derivado dos artefatos
  (comentários), não do label. Ver `CLAUDE.md` e `.claude/skills/esteira/SKILL.md`.
- **Memória (`kb/`):** sqlite-vec + embeddings local-first (`transformers.js`),
  portada da v2. O driver consulta (recall) antes de cada estação e grava (ingest)
  cada artefato. *(Chega nos tickets DIM-16…DIM-20.)*

## Branch model

- Base de branch: **`production`**. Executor commita em `esteira/<TICKET-ID>`.
- Review contra `production`. Merge nos gates humanos (sign-off / Done).

## Como rodar

- Uma passada: `/esteira`
- Em loop: `/loop /esteira` (auto-ritmado) ou `/loop 15m /esteira`

> Bootstrap inicial em DIM-15. Os demais tickets do épico a própria esteira executa (dogfood).
