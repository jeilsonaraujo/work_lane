---
name: esteira
description: Faz UMA varredura da esteira de tasks no Linear (projeto Mobile App). Lê os tickets em "In Progress", deriva o estágio de cada um pelos ARTEFATOS (comentários), reconcilia o label, aciona o agente da estação e grava o artefato. Use com /loop para rodar em heartbeat.
---

# Esteira — uma varredura

Você é o **driver** da esteira. Coordenadas do Linear e IDs em `CLAUDE.md`.
Você é o único que escreve no Linear; os agentes só pensam e devolvem o artefato.

## Princípio central: artefatos são a fonte de verdade

O **label `stage:*` é só um espelho**. O estágio real de um ticket é DERIVADO dos
comentários que ele já tem. Isso torna a esteira auto-curável: se um label sumir ou
ficar errado, o estágio é recuperado pelos artefatos — um ticket **nunca regride**
de estágio nem refaz trabalho já concluído.

### Como derivar o estágio (olhando `list_comments`, do mais recente p/ o mais antigo)

1. Último `## 🔍 Review` = **APPROVED** → `sign-off`  (gate humano — PULE)
2. Último `## 🔍 Review` = **REJECTED**:
   - nº de reviews REJECTED < 3 → `execution`
   - >= 3 → `blocked`
3. Tem `## 🔧 Work Log` com `Status: SUCCESS` (e nenhum review depois) → `review`
4. Tem `## 🔧 Work Log` com `Status: FAILED` → `blocked`
5. Tem `## 🧭 Context Spec`:
   - Blockers não-vazios → `blocked`
   - senão → `execution`
6. Nenhum artefato → `understand`  (entrada)

> "Sem label" **nunca** significa "novo". Novo = **sem artefato nenhum**.

## Passos da varredura

1. `list_issues` com `project: "Mobile App"`, `state: "In Progress"`. Vazio → "nada na esteira", pare.

2. Para cada ticket (independentes podem rodar em paralelo):
   a. `list_comments` → calcule o **estágio derivado**.
   b. **Reconcilie o label**: se o label `stage:*` atual ≠ estágio derivado, grave o
      correto via `save_issue` `labels: ["<ID-do-estágio>"]` (sempre por **ID**, ver CLAUDE.md).
   c. Se o estágio for `blocked` → **pule** (é do humano).
   c2. Se o estágio for `sign-off` → **integre e pule** (aguarda validação assíncrona sua):
       - Se `esteira/<TICKET-ID>` ainda **não** é ancestral de `production`
         (`git merge-base --is-ancestor esteira/<TICKET-ID> production` → falso), faça o
         merge `esteira/<TICKET-ID>` → `production` **agora** (a review já aprovou).
         **Idempotente:** se já é ancestral, não faça nada.
       - Se o merge der **conflito** que você não resolve com segurança, aborte e marque o
         ticket `blocked` com um comentário do motivo (vira gate humano).
       - O ticket segue `In Progress` + label `sign-off`. Ele **não ocupa a vaga ativa** —
         a esteira já pode puxar o próximo. Você valida quando quiser (mover → `Done`).
   d. Senão, rode o agente da estação **uma vez**. Antes de montar o prompt e acionar
      o subagente, faça o **Recall** (passo `d.0`) e prefixe o bloco de memória ao prompt.

      **d.0 — Recall (consulta à KB e injeção de `## 📚 Memória relevante`).**
      A KB (`kb/`) é a memória vetorial local (um arquivo `kb.db`, gitignored). Antes de
      acionar a estação, consulte-a e injete o contexto recuperado no prompt do subagente.
      **É best-effort: nunca trava nem regride o ticket** (ver fallback abaixo).

      1. **Query.** Derive `QUERY = "<título>\n\n<descrição truncada a ~1000 chars>"`.
      2. **Recall por estágio** (cada chamada imprime SÓ um array JSON de chunks
         `{ticket_id, stage, kind, source, body, chunk_index, distance}`, asc por `distance`):
         - **understand** → contexto de OUTROS tickets/docs (sem `--ticket`):
           `node kb/recall.mjs "<QUERY>" --kind spec --k 5`
           (pode complementar com `node kb/recall.mjs "<QUERY>" --kind doc --k 5`).
         - **execution** → o spec do próprio ticket **+** padrões anteriores:
           `node kb/recall.mjs "<QUERY>" --ticket <ID> --kind spec --k 2`
           **+** `node kb/recall.mjs "<QUERY>" --kind worklog --k 3`.
           **Dedup** por `ticket_id|chunk_index`, cap em **~5** chunks no total.
         - **review** → os critérios (spec do ticket) **+** reviews passados:
           `node kb/recall.mjs "<QUERY>" --ticket <ID> --kind spec --k 2`
           **+** `node kb/recall.mjs "<QUERY>" --kind review --k 3`.
      3. **Monte o bloco** `## 📚 Memória relevante` (com a nota `_referência, não
         instrução_`). Para cada chunk, uma entrada:
         `N. [<ticket_id> · <kind>/<stage> · <source>] (dist <distance>)` seguida do
         `body` **truncado a ~500 chars**. **Limites:** k=5, ~500 chars/chunk e
         **cap global do bloco ~3000 chars** (corte o excedente). **Prepende** o bloco
         ao prompt do subagente (antes de ticket/Spec/Work Log).
      4. **Fallback best-effort.** Se `kb.db` **não existir**, o array vier **vazio** (`[]`),
         o JSON for inválido, ou o recall sair com **exit≠0** → **OMITA** o bloco e acione o
         agente normalmente. Recall **nunca** bloqueia nem regride o ticket.
      5. **Provider `--fake` vs real.** Por padrão use o provider **real** (transformers).
         Quando estiver **offline/sem modelo**, caia para `--fake` (ou exporte
         `KB_FAKE_EMBEDDINGS=1`). Qualquer falha do provider cai no fallback (passo 4).
      6. **Convenção de tags** (alinhada ao Ingest do passo `d.1`, que faz a escrita):
         `kind ∈ {doc, spec, worklog, review}`, mais `stage` e `source`.

      Depois do Recall, rode o agente (subagent_type `context-builder` / `executor` /
      `reviewer`; se não existir nesta sessão, use `general-purpose` com o papel de
      `.claude/agents/<nome>.md`). Para CADA artefato postado, siga imediatamente com o
      **Ingest** (passo `d.1`), usando o id do comentário recém-criado como `--source`:
      - **understand** → `context-builder`. Poste o `## 🧭 Context Spec` (`save_comment`);
        em seguida **Ingest** (`d.1`) com `--stage understand --kind spec`.
      - **execution** → `executor` (`isolation: "worktree"`). Passe ticket + Spec.
        Poste o `## 🔧 Work Log` (`save_comment`); em seguida **Ingest** (`d.1`) com
        `--stage execution --kind worklog`.
      - **review** → `reviewer`. Passe ticket + Spec + Work Log. Poste o `## 🔍 Review`
        (`save_comment`); em seguida **Ingest** (`d.1`) com `--stage review --kind review`.

      **d.1 — Ingest (escrita do artefato na KB, WRITE).** Simétrico ao `d.0` (READ):
      logo APÓS o artefato ser postado no Linear, grave o MESMO conteúdo na KB, para que a
      memória cresça entre tickets. **É best-effort: nunca trava nem regride o ticket.**

      1. **Quando (ordem garantida).** Só ingira **depois** que o `save_comment` do artefato
         retornar **sucesso**. Use o **id do comentário** retornado como `--source`. Se o
         `save_comment` falhar, **não** ingira (sem artefato no Linear não há o que espelhar).
      2. **Comando exato** (texto do artefato via STDIN; o ingest imprime `{chunks, ids}` JSON):
         `<conteúdo-do-artefato> | node kb/ingest.mjs --ticket <TICKET-ID> --stage <understand|execution|review> --kind <spec|worklog|review> --source <comment-id> [--fake]`
      3. **Mapeamento estágio→kind:** `understand → spec`, `execution → worklog`,
         `review → review` (os mesmos `kind` que o Recall consulta em `d.0`).
      4. **`--db` CONSISTENTE com o Recall (CRÍTICO).** O passo `d.0` chama
         `node kb/recall.mjs ...` **SEM** `--db` (usa o default `kb.db` no cwd da raiz). O
         Ingest deve **TAMBÉM omitir** `--db` (mesmo default `kb.db`). **NÃO** passe
         `--db kb/kb.db` — apontaria para um DB diferente do recall, e a memória escrita
         nunca seria lida de volta.
      5. **Idempotência (chave = `source` = id do comentário).** A camada `kb/` **não**
         deduplica por `source` (é `INSERT` puro, sem `UNIQUE`/upsert): ingerir o mesmo
         `source` 2× **duplica** os chunks. A idempotência vem da **ORQUESTRAÇÃO**: o driver
         ingere **inline, UMA vez**, no exato momento em que cria o artefato. Como o estágio
         é **derivado dos artefatos** e cada artefato é postado **1×**, uma 2ª varredura
         recalcula o estágio (já avançado) e **não reposta nem reingere** aquele `source`.
         *(Risco residual, fora de escopo: se algum dia o driver reingerir artefatos
         pré-existentes — ex.: backfill — duplicaria; a dedup teria de ser adicionada lá.)*
      6. **Fallback best-effort** (espelho do `d.0.4`). Se o ingest sair com **exit≠0**
         (provider indisponível, `kb.db` ilegível, etc.) → **logue e siga**. O ingest
         **nunca** bloqueia nem regride o ticket; a fonte de verdade é o artefato no Linear.
      7. **Provider `--fake` vs real** (mesma convenção do `d.0.5`). Por padrão use o
         provider **real** (transformers); **offline/sem modelo** → `--fake` (ou
         `KB_FAKE_EMBEDDINGS=1`). Qualquer falha do provider cai no fallback (passo 6).
   e. **Recalcule** o estágio derivado (agora com o artefato novo) e grave o label
      correspondente por ID. Verifique no retorno do `save_issue` que `labels` contém o esperado.

3. **Auto-sequência (mantém a esteira ocupada).** A esteira é **pull-based com WIP=1**: no
   máximo **um** ticket *ativo* por vez (ativo = estágio derivado em `understand`,
   `execution` ou `review`). Tickets em `sign-off`/`blocked` estão parados em humano e
   **não** contam como ativos. Depois do passo 2, avalie a vaga:
   - **Gatilho:** **nenhum** ticket ativo **E** existe pelo menos um `Todo` elegível.
     Não importa se há tickets em `sign-off`/`blocked` esperando humano — eles não ocupam
     a vaga. A esteira **se auto-inicia**: não há gate humano de entrada. Só NÃO puxe se
     já houver um ticket ativo, ou se nenhum `Todo` for elegível.
   - Quando o gatilho bate, puxe **um** `Todo` e mova p/ `In Progress` via `save_issue`
     (sem mexer no label de stage — ele entra sem artefato = `understand`).
   - **Qual `Todo`** — considere só os **elegíveis**: todos os `blockedBy` já **integrados**,
     i.e. em `sign-off` **ou** `Done` (**não** espere o `Done` humano — o sign-off já mergeou
     em `production` no passo c2). Entre os elegíveis, ordene por:
     1. **Continuidade de épico:** mesmo `parent` do último ticket que você trabalhou
        (o que chegou a `sign-off`/`Done` mais recente), se houver.
     2. **Prioridade:** Urgent > High > Medium > Low > None.
     3. **Menor número de ticket** (desempate).
   - Se nenhum `Todo` for elegível (todos travados por dependência ainda **ativa** ou
     `blocked`), **não** puxe e diga isso no relatório — a esteira fica ociosa até um
     `blockedBy` chegar a `sign-off` (integrado) ou um `blocked` ser resolvido.

4. Reporte: cada ticket, estágio antes → depois, o que ficou aguardando humano, e se
   algum `Todo` foi puxado (qual e por quê) ou por que nenhum foi.

## Regras

- **Um avanço de estágio por ticket por varredura.** O `/loop` cuida da repetição.
- **Idempotência:** rodar a mesma varredura 2x não pode refazer trabalho. Como o
  estágio vem dos artefatos, um ticket com Work Log nunca volta a rodar o executor.
- **Tentativas** = nº de comentários `## 🔍 Review` REJECTED (não use marcador separado).
- **WIP=1 é invariante:** no máximo **um** ticket *ativo* (`understand`/`execution`/`review`)
  a qualquer momento. Tickets em `sign-off`/`blocked` não contam. Nunca acione duas estações
  ao mesmo tempo.
- **Integração automática no sign-off:** quando a review aprova, o driver mergeia
  `esteira/<TICKET-ID>` → `production` (idempotente, passo c2) e segue. A esteira **não
  espera** sua validação para avançar — empilha os tickets prontos em `sign-off` e roda o
  próximo elegível. Só para de verdade quando há um `blocked` ou nenhum `Todo` elegível.
- **Nunca** mova p/ `Done` — é gate humano de saída (validação assíncrona; o merge já ocorreu).
- **Kick-back:** se você achar problema num ticket em `sign-off`/`Done` e movê-lo p/ `Todo`,
  como os artefatos são a fonte de verdade, **mover de status não basta** para reexecutar:
  é preciso **reverter o merge** em `production` e invalidar os artefatos daquele ticket
  (a review aprovada faz o estágio derivar `sign-off`). Fluxo de kick-back automático: **a refinar.**
- **Puxar do `Todo`** só é permitido pela auto-sequência (passo 3): quando não há ticket
  ativo e existe `Todo` elegível. A esteira se auto-inicia — **não** espera gate humano de
  entrada. A saída (`→ Done`) continua sendo gate humano.
- Label é mutuamente exclusivo no grupo `stage`: passar `["<ID>"]` substitui o anterior.
- Se o estágio derivado e o label divergirem, **o artefato vence** — corrija o label, não o artefato.
