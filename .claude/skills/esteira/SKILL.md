---
name: esteira
description: Faz UMA varredura da esteira de tasks no Linear (projeto Auto Lane). Lê os tickets em "In Progress", deriva o estágio de cada um pelos ARTEFATOS (comentários), reconcilia o label, aciona o agente da estação e grava o artefato. Quando a review aprova, integra e move p/ "To Review" (gate humano). Use com /loop para rodar em heartbeat.
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

0. **Kick-back (invalida artefatos antigos).** Ache o `## ⛔ Kick-back: <motivo>` mais
   recente (maior `createdAt`) → chame seu `createdAt` de **`KB_TS`**. Esse comentário é um
   **sinal humano** (não um artefato de estação). Se existir, **TODO artefato com `createdAt
   < KB_TS` fica invalidado** — não conta na derivação. As regras 1-6 abaixo passam a olhar
   **somente** artefatos com `createdAt > KB_TS`. Sem kick-back, `KB_TS = -∞` e nada muda
   (comportamento idêntico ao anterior — regras 1-6 intactas). Efeitos:
   - **Anti-loop:** seja `N` = nº de comentários `## ⛔ Kick-back:` no ticket. Se `N >=
     KICKBACK_CAP` (default **2**, configurável) → `blocked` (não reabra; vira gate humano).
     Esse cap é **independente** do limite de 3 reviews REJECTED (regra 2).
   - Senão, se **não há nenhum artefato com `createdAt > KB_TS`** (caso típico logo após o
     kick-back) → cai na regra 6 → `understand`: o ticket **reabre** p/ reavaliar do zero
     (o spec antigo pode estar furado). O `<motivo>` do kick-back é passado ao
     `context-builder` na reabertura. A revert do merge em `production` e o move p/ `In
     Progress` acontecem no passo **c0**.
1. Último `## 🔍 Review` = **APPROVED** → **integra + move p/ status `To Review`** (gate humano — ver passo c2)
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

0. **Resolver coordenadas por nome (ANTES de tudo).** Os IDs de status/label do CLAUDE.md
   são apenas **cache/fallback** — o board pode ser reordenado/recriado e os IDs mudam
   silenciosamente. Resolva os IDs **ao vivo, por nome**, no início de cada sweep e use
   os resolvidos no resto dos passos:
   1. **Status** — `list_issue_statuses` com `team: "3c0058ed-759f-4678-b219-4d34d0f533d7"`
      (Team por ID = âncora estável). Mapeie por **nome exato** (case-sensitive):
      `Todo`, `In Progress`, `To Review`, `Done`, `Canceled` → IDs ao vivo.
   2. **Labels** — `list_issue_labels` com o mesmo `team`. Filtre o grupo `stage`
      (`9e921002-79e5-4435-92af-b2f42025b724`) e mapeie por nome:
      `stage:understand`, `stage:execution`, `stage:review`, `stage:blocked` → IDs ao vivo.
      (`stage:sign-off` é **deprecado** — ignore.)
   3. **Reconcilie** cada nome com o ID hardcoded do CLAUDE.md. Em **divergência**, o
      **resolvido ao vivo vence**; anote `(<nome>: hardcoded <id> → ao vivo <id>)` para o
      relatório (passo 4).
   4. **Fallback:**
      - **Status canônico ausente** (algum dos 5 nomes não aparece) → **ABORTE o sweep**
        com erro claro (`Coordenada de status '<nome>' não resolvida — board renomeado?`).
        Sem status confiável não há como mover tickets com segurança.
      - **Label `stage:*` ausente** → use o **ID hardcoded** desse label + emita **warning**
        no relatório (o pipeline segue; label é só espelho auto-curável).
   5. **Use os IDs resolvidos** em todos os passos seguintes: `list_issues` (status `In
      Progress`), reconciliação de label (2.b/2.e), move p/ `To Review` (c2), pull do
      `Todo` e todas as comparações de status. Onde os passos abaixo dizem "ver CLAUDE.md",
      leia "**use o ID resolvido no passo 0** (CLAUDE.md como fallback)".

1. `list_issues` por **ID do projeto** (`project: "9a2f315c-8def-4698-ba9a-8d0a680cda13"` — use o **ID**, não o nome, que pode mudar), `state: "In Progress"` (**ID resolvido no passo 0**). Vazio → "nada na esteira", pare.

2. Para cada ticket (independentes podem rodar em paralelo):
   a. `list_comments` → calcule o **estágio derivado** (incluindo a **regra 0 de
      kick-back**: ache o `## ⛔ Kick-back:` mais recente → `KB_TS` e ignore artefatos com
      `createdAt < KB_TS`). Se o sinal mais recente é um kick-back, trate no passo **c0**.
   b. **Reconcilie o label**: se o label `stage:*` atual ≠ estágio derivado, grave o
      correto via `save_issue` `labels: ["<ID-do-estágio>"]` (sempre por **ID resolvido no
      passo 0**; CLAUDE.md como fallback).
   c. Se o estágio for `blocked` → **pule** (é do humano).
   c0. **Kick-back (revert + reabertura).** Aplica-se quando o sinal mais recente do ticket
       é um `## ⛔ Kick-back: <motivo>` (i.e. `KB_TS` existe e não há artefato com `createdAt
       > KB_TS`). Antes de tratar o ticket como `understand`, **desfaça a integração** e
       reabra — tudo **idempotente** (rodar 2x não duplica revert nem move duas vezes):
       1. **Anti-loop primeiro.** Se `N` (nº de `## ⛔ Kick-back:`) `>= KICKBACK_CAP`
          (default **2**, configurável) → marque `blocked` + comentário explicando o cap e
          **não** reabra (vira gate humano). Cap distinto do limite de 3 REJECTED.
       2. **Revert idempotente do merge** (só se `esteira/<TICKET-ID>` está integrado em
          `production`):
          - **Integrado?** `git merge-base --is-ancestor esteira/<TICKET-ID> production`
            (exit 0 = integrado; exit≠0 = nunca mergeou → pule a revert, vá ao passo 3).
          - **Ache o merge:** `git log production --merges --grep "esteira/<TICKET-ID>"
            --format=%H -n 1` → `<merge-sha>`.
          - **Já revertido?** `git log production --grep "This reverts commit <merge-sha>"
            --format=%H -n 1` — se **não-vazio**, a revert já existe → **pule** (idempotente).
          - **Reverta:** `git revert -m 1 --no-edit <merge-sha>` em `production` (mainline =
            1 º pai). **Use `git revert`, nunca `reset --hard`** — `production` é publicada.
          - **Conflito** sem resolução segura → `git revert --abort`, marque `blocked` +
            comentário (gate humano) e **não** reabra.
       3. **Reabra o ticket:** `save_issue state: "<id-In-Progress>"` (ID resolvido no passo
          0). **Não** sete o label à mão — a derivação cai em `understand` (regra 6) e o
          passo `e` reconcilia o label. A branch `esteira/<TICKET-ID>` é **reaproveitável**.
       4. **Reexecute** seguindo o passo `d` como um ticket em `understand`, passando o
          `<motivo>` do kick-back ao `context-builder` (o spec antigo foi invalidado pela
          regra 0). O ticket reaberto fica **ativo** (ocupa a vaga WIP=1; a auto-sequência
          do passo 3 não puxa novo `Todo` enquanto ele estiver ativo).
   c2. Se o estágio for `sign-off` (último Review **APPROVED**) → **integre e finalize p/ você**:
       - **Merge idempotente:** se `esteira/<TICKET-ID>` ainda **não** é ancestral de
         `production` (`git merge-base --is-ancestor esteira/<TICKET-ID> production` → falso),
         faça o merge `esteira/<TICKET-ID>` → `production` **agora**. Se já é ancestral, nada.
       - **Conflito** sem resolução segura → marque `blocked` + comentário (vira gate humano).
       - **Mova o ticket p/ o status `To Review`** (`save_issue state: "<id-To-Review>"` —
         **ID resolvido no passo 0**, CLAUDE.md como fallback). Ele **sai de `In Progress`**:
         não ocupa a vaga ativa nem é varrido de novo.
         Fica te aguardando — você move `To Review` → `Done` (aprovou) ou → `Todo` (reprovou).
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
      4. **`--db`: simplesmente OMITA** (Recall e Ingest). O default de ambos é
         `kb.db` **ancorado na raiz do repo** (resolvido pelo próprio script, independente
         do CWD), então recall e ingest sempre convergem no MESMO DB sem você passar nada.
         Só use `--db <x>` para apontar deliberadamente para outro arquivo.
      5. **Idempotência (chave = `source` = id do comentário).** A camada `kb/` **deduplica
         por `source`**: quando há `--source`, `Memory.ingest` remove-antes-de-inserir os
         chunks daquela `source` (metadados + vetores, na mesma transação), então reingerir o
         mesmo `source` **substitui** em vez de duplicar (`source` vazio/null = sem dedup). A
         **ORQUESTRAÇÃO** vira **rede de segurança**, não a única garantia: o driver ainda
         ingere **inline, UMA vez**, no exato momento em que cria o artefato — como o estágio é
         **derivado dos artefatos** e cada artefato é postado **1×**, uma 2ª varredura recalcula
         o estágio (já avançado) e **não reposta nem reingere** aquele `source`.
         *(Risco residual coberto: reingerir artefatos pré-existentes — ex.: backfill — agora é
         seguro pela dedup na camada `kb/`; o caso só duplicaria se `source` viesse vazio.)*
      6. **Fallback best-effort** (espelho do `d.0.4`). Se o ingest sair com **exit≠0**
         (provider indisponível, `kb.db` ilegível, etc.) → **logue e siga**. O ingest
         **nunca** bloqueia nem regride o ticket; a fonte de verdade é o artefato no Linear.
      7. **Provider `--fake` vs real** (mesma convenção do `d.0.5`). Por padrão use o
         provider **real** (transformers); **offline/sem modelo** → `--fake` (ou
         `KB_FAKE_EMBEDDINGS=1`). Qualquer falha do provider cai no fallback (passo 6).
   e. **Recalcule** o estágio derivado (agora com o artefato novo) e reconcilie a saída:
      - Se o estágio recomputado for `sign-off` (você acabou de postar um Review
        **APPROVED**) → **execute o procedimento do passo c2 inline, nesta MESMA
        varredura**: merge idempotente de `esteira/<TICKET-ID>` → `production` (só se ainda
        não for ancestral; conflito sem resolução segura → `blocked` + comentário) e mova o
        ticket p/ o status `To Review` (`save_issue state: "<id-To-Review>"`, ID resolvido
        no passo 0). **NÃO grave label** — `stage:sign-off` é deprecado e não há ID de
        label válido p/ ele; o ticket sai de `In Progress` já integrado, aguardando seu
        gate humano. (O `c2` no topo do passo 2 continua cobrindo, como auto-cura, tickets
        aprovados em sweeps anteriores.)
      - Caso contrário, **grave o label** correspondente ao estágio por ID (resolvido no
        passo 0; CLAUDE.md como fallback). Verifique no retorno do `save_issue` que
        `labels` contém o esperado.

3. **Auto-sequência (mantém a esteira ocupada).** A esteira é **pull-based com WIP=1**: no
   máximo **um** ticket *ativo* por vez (ativo = estágio derivado em `understand`,
   `execution` ou `review`, status `In Progress`). Tickets em `To Review`/`Done` (já saíram
   do `In Progress`) ou `blocked` (parados em humano) **não** contam como ativos. Depois do
   passo 2, avalie a vaga:
   - **Gatilho:** **nenhum** ticket ativo **E** existe pelo menos um `Todo` elegível.
     Não importa quantos tickets estejam em `To Review`/`blocked` esperando você — eles não
     ocupam a vaga. A esteira **se auto-inicia**: não há gate humano de entrada. Só NÃO puxe
     se já houver um ticket ativo, ou se nenhum `Todo` for elegível.
   - Quando o gatilho bate, puxe **um** `Todo` e mova p/ `In Progress` via `save_issue`
     (status por **ID resolvido no passo 0**, CLAUDE.md como fallback; sem mexer no label
     de stage — ele entra sem artefato = `understand`).
   - **Qual `Todo`** — considere só os **elegíveis**: todos os `blockedBy` já **integrados**,
     i.e. em `To Review` **ou** `Done` (**não** espere o `Done` humano — entrar em `To Review`
     já mergeou em `production` no passo c2). Entre os elegíveis, ordene por:
     1. **Continuidade de épico:** mesmo `parent` do último ticket que você trabalhou
        (o que chegou a `To Review`/`Done` mais recente), se houver.
     2. **Prioridade:** Urgent > High > Medium > Low > None.
     3. **Menor número de ticket** (desempate).
   - Se nenhum `Todo` for elegível (todos travados por dependência ainda **ativa** ou
     `blocked`), **não** puxe e diga isso no relatório — a esteira fica ociosa até um
     `blockedBy` chegar a `To Review` (integrado) ou um `blocked` ser resolvido.

4. Reporte: comece com a linha **"Coordenadas resolvidas"** (passo 0) — liste as
   divergências hardcoded × ao vivo e os warnings de label ausente, ou "sem divergências".
   Depois: cada ticket, estágio antes → depois, o que ficou aguardando humano, e se algum
   `Todo` foi puxado (qual e por quê) ou por que nenhum foi.

## Regras

- **Um avanço de estágio por ticket por varredura.** O `/loop` cuida da repetição.
- **Idempotência:** rodar a mesma varredura 2x não pode refazer trabalho. Como o
  estágio vem dos artefatos, um ticket com Work Log nunca volta a rodar o executor.
- **Tentativas** = nº de comentários `## 🔍 Review` REJECTED (não use marcador separado).
- **WIP=1 é invariante:** no máximo **um** ticket *ativo* (`understand`/`execution`/`review`,
  status `In Progress`) a qualquer momento. Tickets em `To Review`/`Done`/`blocked` não contam.
  Nunca acione duas estações ao mesmo tempo.
- **Integração automática + `To Review`:** quando a review aprova, o driver mergeia
  `esteira/<TICKET-ID>` → `production` (idempotente, passo c2) e **move o ticket p/ `To Review`**.
  A esteira **não espera** sua validação para avançar — empilha os tickets prontos em
  `To Review` e roda o próximo elegível. Só para quando há `blocked` ou nenhum `Todo` elegível.
- **Nunca** mova p/ `Done` — é gate humano de saída. A esteira para no `To Review` (o merge já
  ocorreu); você valida e move `To Review` → `Done`.
- **Kick-back (reprovar em `To Review`/`Done`):** como os artefatos são a fonte de verdade,
  **mover o status de volta não basta** p/ reexecutar — a review APPROVED antiga continua
  derivando `To Review` e o merge já está em `production`. O sinal humano é um comentário com
  header fixo `## ⛔ Kick-back: <motivo>` (sinal, não artefato de estação). Com ele, o driver,
  de forma **automática e idempotente** (ver regra 0 da derivação + passo c0):
  1. **Invalida** todo artefato com `createdAt < createdAt do kick-back mais recente` (`KB_TS`)
     — a derivação passa a olhar só artefatos posteriores, então o ticket volta a `understand`.
  2. **Reverte o merge** em `production` (`git merge-base --is-ancestor` + `git log --merges
     --grep` p/ achar o merge + checagem de revert prévio + `git revert -m 1 --no-edit`;
     **nunca** `reset --hard`). Conflito sem resolução segura → `blocked`.
  3. **Reabre** o ticket em `In Progress` no estágio **understand** (reavaliar do zero — o spec
     antigo pode estar furado), passando o `<motivo>` ao `context-builder`.
  4. **Anti-loop:** `N` = nº de comentários `## ⛔ Kick-back:`; se `N >= KICKBACK_CAP`
     (default **2**, configurável) → `blocked` em vez de reabrir. Cap **independente** do
     limite de 3 REJECTED.
- **Puxar do `Todo`** só é permitido pela auto-sequência (passo 3): quando não há ticket
  ativo e existe `Todo` elegível. A esteira se auto-inicia — **não** espera gate humano de
  entrada. A saída (`→ Done`) continua sendo gate humano.
- **Coordenadas por nome:** os IDs de status/label são **resolvidos por nome a cada sweep**
  (passo 0); a tabela do CLAUDE.md é só cache/fallback. Os nomes canônicos das colunas
  (`Todo`/`In Progress`/`To Review`/`Done`/`Canceled`) e labels (`stage:understand/execution/review/blocked`)
  são contrato — não os renomeie.
- Label é mutuamente exclusivo no grupo `stage`: passar `["<ID>"]` (ID resolvido no passo 0)
  substitui o anterior.
- Se o estágio derivado e o label divergirem, **o artefato vence** — corrija o label, não o artefato.

## Cenário: kick-back (reprovação na saída)

DIM-XX está em `To Review` (Review APPROVED, merge já em `production`). Você revisa, não
gosta, e cola um comentário `## ⛔ Kick-back: faltou tratar o caso vazio`.

1. **Caminho feliz.** No próximo sweep, a regra 0 acha o kick-back (`KB_TS`) e invalida o
   Context Spec/Work Log/Review antigos (todos com `createdAt < KB_TS`). Não há artefato
   posterior → estágio `understand`. O passo c0 confirma que `esteira/DIM-XX` é ancestral de
   `production`, acha o merge, reverte com `git revert -m 1 --no-edit`, e reabre o ticket em
   `In Progress`. O `context-builder` recebe o `<motivo>` e refaz o spec.
2. **Idempotência.** Se o sweep rodar de novo antes de um novo artefato existir, c0 vê que já
   há um commit `This reverts commit <merge-sha>` em `production` → **pula** a revert; e o
   ticket já está em `In Progress` → o `save_issue` é no-op. Nada duplica.
3. **Anti-loop.** Se este é o **2º** `## ⛔ Kick-back:` do ticket (`N >= KICKBACK_CAP` = 2),
   o driver marca `blocked` + comentário em vez de reabrir — evita ping-pong infinito. Esse
   teto é separado do limite de 3 reviews REJECTED.
