---
name: lane
description: Runs ONE sweep of the Work Lane task pipeline on Linear (project Auto Lane). Reads the tickets in "In Progress", derives each one's stage from its ARTIFACTS (comments), reconciles the label, triggers the station's agent and writes the artifact. When the review approves, it integrates and moves to "To Review" (human gate). Use with /loop to run as a heartbeat.
---

# Work Lane — one sweep

You are the **driver** of the lane. Linear coordinates and IDs are in `CLAUDE.md`.
You are the only one who writes to Linear; the agents only think and return the artifact.

## Core principle: artifacts are the source of truth

The **`stage:*` label is just a mirror**. A ticket's real stage is DERIVED from the
comments it already has. This makes the lane self-healing: if a label disappears or
goes wrong, the stage is recovered from the artifacts — a ticket **never regresses**
in stage nor redoes work already completed.

### Strict parsing of the verdict/status (anchored regexes)

Derivation **never** decides by a loose substring in the prose (e.g. the word "APPROVED"
in the middle of a sentence, or "FAILED" quoted in a comment). It matches **only** the
**structured field** of the artifact — the line starts at `^`, with the label in bold and
a colon, exactly as the agents emit it. Canonical regexes (multiline mode, matched
per line):

- **Verdict** (`## 🔍 Review`): `^\*\*Verdict:\*\*\s*(APPROVED|REJECTED)\b`
- **Status** (`## 🔧 Work Log`): `^\*\*Status:\*\*\s*(SUCCESS|FAILED)\b`
- **Blockers** (`## 🧭 Context Spec`): line `^\*\*Blockers:\*\*` present (empty = no blockers).

(Format confirmed in the agents: `.claude/agents/reviewer.md` emits `**Verdict:** APPROVED | REJECTED`,
`executor.md` emits `**Status:** SUCCESS | FAILED`, `context-builder.md` emits `**Blockers:** …`.)

**Malformed.** If the artifact **header** is present but the **field** does not match the
regex (label missing, value outside the enum, value loose only in the prose, more than one
field line) → the artifact is **malformed**: do NOT interpret it by substring; treat it as
`blocked` with a reason (`field <X> not matchable in the <station> artifact`). The generation of
this case is prevented at the source by the **pre-post validation** (step `d`), which re-asks the agent
once before any post.

### How to derive the stage (looking at `list_comments`, from most recent to oldest)

> **Recency short-circuit (cheap derivation).** Scan the comments **newest → oldest** and
> **stop as soon as one of rules 1–6 decides** the stage — an older comment can never override
> a more recent decision. Derivation only needs, per artifact, the **header**, the single
> **structured-field line** (the regex match), and its **`createdAt`** — it **does NOT** need
> the full artifact body. **Do not retain full artifact bodies** in the driver's context: the
> prose of a Context Spec / Work Log / Review is irrelevant to the stage decision and keeping
> it only inflates sustained context (see "Per-sweep context boundary" below).

1. Last `## 🔍 Review` whose field matches `^\*\*Verdict:\*\*\s*(APPROVED|REJECTED)\b` = **APPROVED**
   → **integrate + move to status `To Review`** (human gate — see step c2).
   (Header `## 🔍 Review` present but Verdict not matchable → **malformed → `blocked`**.)
2. Last `## 🔍 Review` with Verdict (same regex) = **REJECTED**:
   - number of REJECTED reviews < 3 → `execution`
   - >= 3 → `blocked`
   The **REJECTED count** uses the same field matched by the regex — **never** count
   occurrences of the word "REJECTED" in the prose.
3. There is a `## 🔧 Work Log` whose field matches `^\*\*Status:\*\*\s*(SUCCESS|FAILED)\b` = **SUCCESS**
   (and no review after it) → `review`.
4. There is a `## 🔧 Work Log` with Status (same regex) = **FAILED** → `blocked`.
   (Header `## 🔧 Work Log` present but Status not matchable → **malformed → `blocked`**.)
5. There is a `## 🧭 Context Spec` (with the line `^\*\*Blockers:\*\*` present):
   - non-empty Blockers → `blocked`
   - otherwise → `execution`
6. No artifact → `understand`  (entry)

> **Never derive from a substring in the prose.** Only the **structured field** (line anchored
> at `^`, regex above) decides. Header present + field not matchable = **malformed →
> `blocked` with reason** — do not guess the value.

> "No label" **never** means "new". New = **no artifact at all**.

## Sweep steps

−1. **Single-driver lock (anti-concurrency).** BEFORE step 0 (and any read
   of Linear), acquire a mutual-exclusion lock. Two `/lane` runs at the same time would break
   WIP=1; the lock guarantees **one driver at a time**. Path: `.claude/esteira.lock.d/`
   (directory — `mkdir` is **atomic**, serves as a mutex). Content: a `meta` file with
   `epoch PID timestamp-ISO`. A 30min TTL reclaims an orphan lock (driver died without releasing).
   Run this block; if it **aborts** (exit 0, fresh lock from another driver), **do not touch
   Linear**:
   ```sh
   LOCK=.claude/esteira.lock.d
   TTL=1800   # 30 min, > typical /loop interval
   NOW=$(date -u +%s)
   if mkdir "$LOCK" 2>/dev/null; then
     : # lock acquired (mkdir is atomic)
   else
     LOCK_EPOCH=$(cut -d' ' -f1 "$LOCK/meta" 2>/dev/null || echo 0)
     if [ $(( NOW - LOCK_EPOCH )) -gt "$TTL" ]; then
       rm -rf "$LOCK" && mkdir "$LOCK"   # stale lock → take the lock
     else
       echo "lane: another driver active (fresh lock) — aborting sweep."
       exit 0   # ABORTS silently, WITHOUT touching Linear
     fi
   fi
   printf '%s %s %s\n' "$NOW" "$$" "$(date -u +%FT%TZ)" > "$LOCK/meta"
   ```
   Notes: `mkdir` fails if the dir already exists (atomic → no race); a lock older than
   the TTL is considered orphan and **reclaimed**; when the lock is **fresh**, the sweep aborts
   with `exit 0` **without** reading/writing Linear. The lock is **released in step 4**; if the
   driver dies before that, the TTL reclaims it on the next sweep.

0. **Resolve coordinates by name (BEFORE everything).** The status/label IDs in CLAUDE.md
   are only **cache/fallback** — the board can be reordered/recreated and the IDs change
   silently. Resolve the IDs **live, by name**, at the start of each sweep and use
   the resolved ones in the rest of the steps:
   1. **Status** — `list_issue_statuses` with `team: "3c0058ed-759f-4678-b219-4d34d0f533d7"`
      (Team by ID = stable anchor). Map by **exact name** (case-sensitive):
      `Todo`, `In Progress`, `To Review`, `Done`, `Canceled` → live IDs.
   2. **Labels** — `list_issue_labels` with the same `team`. Filter the `stage` group
      (`9e921002-79e5-4435-92af-b2f42025b724`) and map by name:
      `stage:understand`, `stage:execution`, `stage:review`, `stage:blocked` → live IDs.
      (`stage:sign-off` is **deprecated** — ignore it.)
   3. **Reconcile** each name with the hardcoded ID from CLAUDE.md. On **divergence**, the
      **live-resolved one wins**; note `(<name>: hardcoded <id> → live <id>)` for the
      report (step 4).
   4. **Fallback:**
      - **Canonical status missing** (any of the 5 names does not appear) → **ABORT the sweep**
        with a clear error (`Status coordinate '<name>' not resolved — board renamed?`).
        Without a reliable status there is no way to move tickets safely.
      - **`stage:*` label missing** → use the **hardcoded ID** of that label + emit a **warning**
        in the report (the pipeline continues; the label is just a self-healing mirror).
   5. **Use the resolved IDs** in all the following steps: `list_issues` (status `In
      Progress`), label reconciliation (2.b/2.e), move to `To Review` (c2), pull from
      `Todo` and all status comparisons. Where the steps below say "see CLAUDE.md",
      read "**use the ID resolved in step 0**" (CLAUDE.md as fallback).

0.6. **Resolve artifact-prose language (`LANE_LANG`).** AFTER resolving coordinates and
   BEFORE step 1, resolve the human-readable PROSE language for this sweep. This affects
   ONLY the natural-language prose the stations write into Linear comments — **never** the
   protocol markers/headers (`## 🧭 Context Spec` / `## 🔧 Work Log` / `## 🔍 Review` /
   `## 📚 Relevant memory`) nor the structured fields parsed by the
   derivation regexes (`**Blockers:**` / `**Status:** SUCCESS|FAILED` / `**Verdict:**
   APPROVED|REJECTED`), which stay verbatim in English. Read the key from the gitignored
   `<repo>/.env` (no node, no new dependency), in the style of the step −1 lock block:
   ```sh
   LANE_LANG=$(grep -E '^[[:space:]]*LANE_LANG[[:space:]]*=' .env 2>/dev/null \
     | tail -n1 | cut -d= -f2- | tr -d ' "'"'"'')
   case "$LANE_LANG" in
     pt|pt-BR|pt-br|PT|PT-BR) LANE_LANG_RESOLVED="pt-BR" ;;
     en|EN|"")               LANE_LANG_RESOLVED="en" ;;
     *)                       LANE_LANG_RESOLVED="en" ;;
   esac
   echo "lane: artifact-prose language resolved = $LANE_LANG_RESOLVED"
   ```
   Resolution rules: reads `<repo>/.env`; **missing file / absent-or-empty key /
   unrecognized value → fall back to `en`**. Log the resolved value and **carry
   `LANE_LANG_RESOLVED` through the whole sweep** — it is threaded into every station
   prompt (step `d.0`) and reported in step 4.
   `en` is effectively a no-op (the repo is English by default).

1. `list_issues` by **project ID** (`project: "9a2f315c-8def-4698-ba9a-8d0a680cda13"` — use the **ID**, not the name, which can change), `state: "In Progress"` (**ID resolved in step 0**). Empty → "nothing in the lane", stop.

2. For each ticket (independent ones can run in parallel):
   a. `list_comments` → compute the **derived stage**.
      **Scan the comments newest → oldest and short-circuit:** stop as soon as rules 1–6
      decide the stage (the most recent matching artifact wins; older ones cannot change it).
      Keep only what the decision needs — each candidate artifact's **header**, its single
      **structured-field line** (the regex match) and its **`createdAt`** — and **do NOT keep
      the full artifact bodies** in the driver's context (they are reconstructible from Linear
      and only inflate sustained cost; see "Per-sweep context boundary").
   b. **Reconcile the label**: if the current `stage:*` label ≠ derived stage, write the
      correct one via `save_issue` `labels: ["<stage-ID>"]` (always by **ID resolved in
      step 0**; CLAUDE.md as fallback).
   c. If the stage is `blocked` → **skip** (it belongs to the human).
   c2. If the stage is `sign-off` (last Review **APPROVED**) → **integrate and finalize for you**:
       - **Idempotent merge:** if `esteira/<TICKET-ID>` is still **not** an ancestor of
         `production` (`git merge-base --is-ancestor esteira/<TICKET-ID> production` → false),
         do the merge `esteira/<TICKET-ID>` → `production` **now**. If it already is an ancestor, nothing.
       - **Conflict** without a safe resolution → mark `blocked` + a comment (becomes a human gate).
       - **Move the ticket to status `To Review`** (`save_issue state: "<id-To-Review>"` —
         **ID resolved in step 0**, CLAUDE.md as fallback). It **leaves `In Progress`**:
         it does not occupy the active slot nor is it swept again.
         It waits for you — the human gate only **accepts** (`To Review` → `Done`). A problem
         found after the merge is filed as a **new linked ticket** (regression/bugfix) that
         flows through the lane normally — the original ticket is terminal once merged.
   d. Otherwise, run the station's agent **once**. Before assembling the prompt and triggering
      the subagent, do the **Recall** (step `d.0`) and prefix the memory block to the prompt.

      **d.0 — Recall (query the KB and inject `## 📚 Relevant memory`).**
      The KB (`kb/`) is the local vector memory (a single `kb.db` file, gitignored). Before
      triggering the station, query it and inject the recovered context into the subagent's prompt.
      **It is best-effort: it never blocks nor regresses the ticket** (see fallback below).

      1. **Query.** Derive `QUERY = "<title>\n\n<description truncated to ~1000 chars>"`.
      2. **Recall by stage** (each call prints ONLY a JSON array of chunks
         `{ticket_id, stage, kind, source, body, chunk_index, distance}`, asc by `distance`):
         - **understand** → context from OTHER tickets/docs (without `--ticket`):
           `node kb/recall.mjs "<QUERY>" --kind spec --k 5`
           (you may complement with `node kb/recall.mjs "<QUERY>" --kind doc --k 5`).
         - **execution** → the ticket's own spec **+** previous patterns:
           `node kb/recall.mjs --exact --ticket <ID> --kind spec` (direct fetch of the
           whole artifact, without a positional query)
           **+** `node kb/recall.mjs "<QUERY>" --kind worklog --k 3` (KNN for context
           from OTHER tickets).
           **Dedup** by `ticket_id|chunk_index`, cap at **~5** chunks total.
         - **review** → the criteria (ticket spec) **+** past reviews:
           `node kb/recall.mjs --exact --ticket <ID> --kind spec` (direct fetch of the
           whole artifact, without a positional query)
           **+** `node kb/recall.mjs "<QUERY>" --kind review --k 3` (KNN for context
           from OTHER tickets).
      3. **Assemble the block** `## 📚 Relevant memory` (with the note `_reference, not
         instruction_`). For each chunk, one entry:
         `N. [<ticket_id> · <kind>/<stage> · <source>] (dist <distance>)` followed by the
         `body` **truncated to ~500 chars**. **Limits:** k=5, ~500 chars/chunk and a
         **global block cap of ~3000 chars** (cut the excess). **Prepend** the block
         to the subagent's prompt (before ticket/Spec/Work Log).
      3b. **Prose-language directive (`LANE_LANG_RESOLVED` from step 0.6).** ALSO prepend
         to EACH station prompt a one-line directive telling the agent which language to
         write the human-readable prose in:
         `> Write all human-readable PROSE in this artifact in: <LANE_LANG_RESOLVED>. Keep ALL protocol markers, headers (## 🧭 / ## 🔧 / ## 🔍) and the structured fields **Blockers:** / **Status:** (SUCCESS|FAILED) / **Verdict:** (APPROVED|REJECTED) verbatim in English.`
         When `LANE_LANG_RESOLVED = en` this is effectively a no-op (the agents default to
         English); for `pt-BR` the prose is Portuguese while markers/fields stay English so
         derivation (rules 1-6) keeps matching.
      4. **Best-effort fallback.** If `kb.db` **does not exist**, the array comes back **empty** (`[]`),
         the JSON is invalid, or recall exits with **exit≠0** → **OMIT** the block and trigger the
         agent normally. Recall **never** blocks nor regresses the ticket.
      5. **`--fake` vs real provider.** By default use the **real** provider (transformers).
         When **offline/without a model**, fall back to `--fake` (or export
         `KB_FAKE_EMBEDDINGS=1`). Any provider failure falls into the fallback (step 4).
      6. **Tag convention** (aligned with the Ingest of step `d.1`, which does the write):
         `kind ∈ {doc, spec, worklog, review}`, plus `stage` and `source`.

      After the Recall, run the agent (subagent_type `context-builder` / `executor` /
      `reviewer`; if it does not exist in this session, use `general-purpose` with the role of
      `.claude/agents/<name>.md`). **Before** the `save_comment` of each artifact, do the
      **Format validation (step `d.0.6`)**; only post what passes. For EACH artifact
      posted, immediately follow with the **Ingest** (step `d.1`), using the id of the comment
      just created as `--source`:
      - **understand** → `context-builder`. **Validate (d.0.6)** the `## 🧭 Context Spec`;
        if it passes, post (`save_comment`) and then **Ingest** (`d.1`) with
        `--stage understand --kind spec`.
      - **execution** → `executor` (`isolation: "worktree"`). Pass ticket + Spec.
        The isolation worktree inherits the **local HEAD of `production`** via
        `worktree.baseRef: "head"` (config in `.claude/settings.json`; see CLAUDE.md).
        **Validate (d.0.6)** the `## 🔧 Work Log`; if it passes, post (`save_comment`) and then
        **Ingest** (`d.1`) with `--stage execution --kind worklog`.
      - **review** → `reviewer`. Pass ticket + Spec + Work Log. **Validate (d.0.6)** the
        `## 🔍 Review`; if it passes, post (`save_comment`) and then **Ingest** (`d.1`)
        with `--stage review --kind review`.

      **d.0.6 — Format validation (pre-post).** BEFORE each `save_comment` (and the
      Ingest `d.1`), validate that the artifact returned by the agent matches the station's
      template. An artifact outside the template **is not posted nor ingested** — that way
      derivation (rules 1-6) never sees a malformed field. Checks per station:
      - **understand** (`context-builder`): header `## 🧭 Context Spec` present **and**
        line `^\*\*Blockers:\*\*` present (empty = no blockers).
      - **execution** (`executor`): header `## 🔧 Work Log` present **and** a line matching
        `^\*\*Status:\*\*\s*(SUCCESS|FAILED)` (exactly one Status field).
      - **review** (`reviewer`): header `## 🔍 Review` present **and** a line matching
        `^\*\*Verdict:\*\*\s*(APPROVED|REJECTED)` (exactly one Verdict field).

      **Failure policy (re-ask 1×, otherwise `blocked`):**
      1. If validation fails, **re-trigger the SAME agent once**, attaching to the prompt the
         **reason** for the failure + the **expected template** (header + required field).
      2. If the 2nd attempt **also** fails → **DO NOT** post the artifact (and **do not** ingest
         into the KB) → mark the ticket `blocked` + a comment:
         `artifact malformed by the <station> agent after 1 retry: <reason>`.
      3. **Idempotency:** since nothing was posted, the derived stage does not change; the next
         sweep simply **re-tries** the station from scratch (no orphan artifact in the KB).

      **d.1 — Ingest (write the artifact to the KB, WRITE).** Symmetric to `d.0` (READ):
      right AFTER the artifact is posted to Linear, write the SAME content to the KB, so that
      the memory grows between tickets. **It is best-effort: it never blocks nor regresses the ticket.**

      1. **When (guaranteed order).** Only ingest **after** the artifact's `save_comment`
         returns **success**. Use the **comment id** returned as `--source`. If
         `save_comment` fails, **do not** ingest (without an artifact in Linear there is nothing to mirror).
      2. **Exact command** (artifact text via STDIN; the ingest prints `{chunks, ids}` JSON):
         `<artifact-content> | node kb/ingest.mjs --ticket <TICKET-ID> --stage <understand|execution|review> --kind <spec|worklog|review> --source <comment-id> [--fake]`
      3. **Stage→kind mapping:** `understand → spec`, `execution → worklog`,
         `review → review` (the same `kind`s that Recall queries in `d.0`).
      4. **`--db`: simply OMIT it** (Recall and Ingest). The default of both is
         `kb.db` **anchored at the repo root** (resolved by the script itself, independent of
         the CWD), so recall and ingest always converge on the SAME DB without you passing anything.
         Only use `--db <x>` to deliberately point at another file.
      5. **Idempotency (key = `source` = comment id).** The `kb/` layer **deduplicates
         by `source`**: when there is a `--source`, `Memory.ingest` removes-before-inserting the
         chunks of that `source` (metadata + vectors, in the same transaction), so re-ingesting the
         same `source` **replaces** instead of duplicating (empty/null `source` = no dedup). The
         **ORCHESTRATION** becomes a **safety net**, not the only guarantee: the driver still
         ingests **inline, ONCE**, at the exact moment it creates the artifact — since the stage is
         **derived from the artifacts** and each artifact is posted **1×**, a 2nd sweep recomputes
         the stage (already advanced) and **does not repost nor re-ingest** that `source`.
         *(Residual risk covered: re-ingesting pre-existing artifacts — e.g. backfill — is now
         safe thanks to the dedup in the `kb/` layer; the case would only duplicate if `source` came empty.)*
      6. **Best-effort fallback** (mirror of `d.0.4`). If ingest exits with **exit≠0**
         (provider unavailable, `kb.db` unreadable, etc.) → **log and continue**. The ingest
         **never** blocks nor regresses the ticket; the source of truth is the artifact in Linear.
      7. **`--fake` vs real provider** (same convention as `d.0.5`). By default use the
         **real** provider (transformers); **offline/without a model** → `--fake` (or
         `KB_FAKE_EMBEDDINGS=1`). Any provider failure falls into the fallback (step 6).
      8. **Discard the artifact body (context boundary).** Once the artifact has passed
         validation (`d.0.6`), been posted (`save_comment`) and ingested (`d.1`), the driver
         **drops the full artifact text from its working context**. The only thing the rest
         of the sweep needs is the **already-validated structured field** (`Verdict` /
         `Status` / `Blockers`) — which step `e` uses to recompute the stage — plus the new
         comment id. Retaining the full subagent body (Context Spec / Work Log / Review)
         after this point serves no purpose and is the main driver of sustained context cost
         (see "Per-sweep context boundary").
   e. **Recompute** the derived stage (now with the new artifact) and reconcile the output.
      This recompute only needs the **already-validated structured field** from `d.0.6` (not
      the full body discarded in `d.1.8`):
      - If the recomputed stage is `sign-off` (you just posted an APPROVED Review)
        → **execute the procedure of step c2 inline, in this SAME
        sweep**: idempotent merge of `esteira/<TICKET-ID>` → `production` (only if not yet
        an ancestor; conflict without a safe resolution → `blocked` + a comment) and move the
        ticket to status `To Review` (`save_issue state: "<id-To-Review>"`, ID resolved
        in step 0). **DO NOT write a label** — `stage:sign-off` is deprecated and there is no valid
        label ID for it; the ticket leaves `In Progress` already integrated, awaiting your
        human gate. (The `c2` at the top of step 2 keeps covering, as self-healing, tickets
        approved in previous sweeps.)
      - Otherwise, **write the label** corresponding to the stage by ID (resolved in
        step 0; CLAUDE.md as fallback). Check in the `save_issue` return that
        `labels` contains the expected one.

3. **Auto-sequence (keeps the lane busy).** The lane is **pull-based with WIP=1**: at
   most **one** *active* ticket at a time (active = derived stage in `understand`,
   `execution` or `review`, status `In Progress`). Tickets in `To Review`/`Done` (already left
   `In Progress`) or `blocked` (stopped at a human) **do not** count as active. After
   step 2, evaluate the slot:
   - **Trigger:** **no** active ticket **AND** there is at least one eligible `Todo`.
     It does not matter how many tickets are in `To Review`/`blocked` waiting for you — they do not
     occupy the slot. The lane **self-starts**: there is no human entry gate. Only do NOT pull
     if there is already an active ticket, or if no `Todo` is eligible.
   - When the trigger fires, pull **one** `Todo` and move it to `In Progress` via `save_issue`
     (status by **ID resolved in step 0**, CLAUDE.md as fallback; without touching the stage
     label — it enters without an artifact = `understand`).
   - **Which `Todo`** — consider only the **eligible** ones: all their `blockedBy` already **integrated**,
     i.e. in `To Review` **or** `Done` (**do not** wait for the human `Done` — entering `To Review`
     already merged into `production` in step c2). Query the candidate `Todo`s scoped to the
     **project ID** and `state: "Todo"`, reading only the **minimal fields** needed to order
     them (identifier/number, `priority`, `parent`, `blockedBy` status) — do not pull comment
     bodies or descriptions here. Among the eligible ones, order by:
     1. **Epic continuity (reconstructed from Linear, NOT session memory).** Determine the
        **epic-continuity anchor** by querying the project's tickets in `To Review`/`Done`
        and taking the one with the **greatest `updatedAt`** (the most recently integrated
        ticket); its `parent` is the anchor epic. Prefer eligible `Todo`s with the **same
        `parent`** as that anchor. This is recomputed every sweep from Linear, so it survives
        a fresh/compacted context — the driver **never** relies on remembering "the last
        ticket I worked on" from a previous sweep. (No `To Review`/`Done` ticket yet → no
        anchor → skip this criterion.)
     2. **Priority:** Urgent > High > Medium > Low > None.
     3. **Lowest ticket number** (tie-break).
   - If no `Todo` is eligible (all blocked by a still **active** dependency or
     `blocked`), **do not** pull and say so in the report — the lane stays idle until a
     `blockedBy` reaches `To Review` (integrated) or a `blocked` is resolved.

4. Report: start with the line **"Resolved coordinates"** (step 0) — list the
   divergences hardcoded × live and the missing-label warnings, or "no divergences";
   append the resolved artifact-prose language from step 0.6 (e.g. `· prose language:
   <en|pt-BR>`). Then: each ticket, stage before → after, what was left awaiting a human,
   and whether any `Todo` was pulled (which one and why) or why none was.

   - **Context boundary (before releasing the lock):** the sweep is over — **discard the
     sweep's entire working set**: the active ticket's `list_comments` history, every subagent
     artifact body, the recall block and any transient derivation scratch. Nothing here needs
     to survive into the next heartbeat: ALL cross-sweep state is reconstructed from Linear
     (coordinates in step 0, derived stage in step 2a, epic-continuity anchor in step 3) and
     disk (the lock). The next `/loop /lane` heartbeat must start from a **fresh / compacted
     context** and rebuild everything it needs — it must NOT depend on anything remembered
     from this sweep. (See "Per-sweep context boundary" in Rules.)
   - **Release the lock (last, after the report):** `rm -rf .claude/esteira.lock.d`. Do this
     even if the sweep did not touch anything. If the driver dies before reaching here, the
     TTL (step −1) reclaims the lock on the next sweep — no lock stays stuck forever.

## Rules

- **One stage advance per ticket per sweep.** The `/loop` handles the repetition.
- **Stateless per sweep.** A sweep is a **self-contained context unit**: it reconstructs ALL
  cross-sweep state from Linear (coordinates in step 0, the derived stage in step 2a, the
  epic-continuity anchor in step 3) and disk (the lock in step −1), and must **NOT** depend on
  anything remembered from a previous sweep. This is what makes a fresh/compacted context per
  heartbeat safe — the truth lives in Linear (artifacts) + git (`production`/branches) + disk
  (lock), never in the driver's session memory.
- **An artifact outside the template is not posted.** Derivation decides only by the **structured
  field** (line anchored at `^`, canonical regexes at the top); never by a substring in the
  prose. The pre-post validation (`d.0.6`) guarantees that every posted artifact has a header +
  matchable field; failure after 1 retry → `blocked`, nothing posted/ingested (idempotent).
- **Idempotency:** running the same sweep 2x must not redo work. Since the
  stage comes from the artifacts, a ticket with a Work Log never runs the executor again.
- **Attempts** = number of `## 🔍 Review` REJECTED comments (do not use a separate marker).
- **WIP=1 is invariant:** at most **one** *active* ticket (`understand`/`execution`/`review`,
  status `In Progress`) at any time. Tickets in `To Review`/`Done`/`blocked` do not count.
  Never trigger two stations at the same time.
- **One driver at a time:** the sweep acquires `.claude/esteira.lock.d` (atomic mkdir, TTL 30min)
  at the start and releases it at the end; a 2nd concurrent driver aborts silently.
- **Automatic integration + `To Review`:** when the review approves, the driver merges
  `esteira/<TICKET-ID>` → `production` (idempotent, step c2) and **moves the ticket to `To Review`**.
  The lane **does not wait** for your validation to advance — it stacks the ready tickets in
  `To Review` and runs the next eligible one. It only stops when there is a `blocked` or no eligible `Todo`.
- **Never** move to `Done` — that is the human exit gate. The lane stops at `To Review` (the merge already
  happened); you validate and move `To Review` → `Done`.
- **Forward-only (a merged ticket is terminal):** once a ticket is integrated and moved to
  `To Review`/`Done`, the lane never reopens nor reverts it. A problem found after the merge
  becomes a **NEW linked ticket** (regression/bugfix) that flows through the lane normally. An
  emergency revert of a bad merge is a rare, **manual, human action** — the lane does not
  automate it.
- **Pulling from `Todo`** is only allowed by the auto-sequence (step 3): when there is no active
  ticket and there is an eligible `Todo`. The lane self-starts — it does **not** wait for a human entry
  gate. The exit (`→ Done`) remains a human gate.
- **Coordinates by name:** the status/label IDs are **resolved by name each sweep**
  (step 0); the CLAUDE.md table is just cache/fallback. The canonical column names
  (`Todo`/`In Progress`/`To Review`/`Done`/`Canceled`) and labels (`stage:understand/execution/review/blocked`)
  are a contract — do not rename them.
- The label is mutually exclusive within the `stage` group: passing `["<ID>"]` (ID resolved in step 0)
  replaces the previous one.
- If the derived stage and the label diverge, **the artifact wins** — fix the label, not the artifact.

## Per-sweep context boundary (sustained cost)

Under `/loop /lane` the driver runs as a long-lived heartbeat. If each sweep kept its working
set — the active ticket's full `list_comments` re-read every sweep, plus the full subagent
artifact bodies (Context Spec / Work Log / Review) flowing back from the stations — that text
would **accumulate across heartbeats** and push the sustained context past 150k+. None of it
needs to persist: every sweep is **stateless** (see Rules) and rebuilds what it needs.

**Mechanism (where the cost is shed):**
- **Derivation (step 2a)** scans comments newest → oldest and **short-circuits** at the first
  deciding rule, keeping only `header + structured-field line + createdAt` per candidate —
  **never** the full bodies.
- **Post + ingest (step d.1.8)** discards each subagent artifact body right after
  `save_comment` + Ingest; only the validated structured field (used by step `e`) and the new
  comment id are carried forward.
- **Sweep end (step 4)** marks the **context boundary**: discard the whole working set
  (comment history, artifact texts, recall block) before releasing the lock. The next
  heartbeat must start from a **fresh / compacted context**.

**Why it's safe:** the boundary changes **nothing** about correctness because the driver is
already stateless-per-sweep. All durable state is reconstructed every sweep from the only real
stores: **Linear** (coordinates by name in step 0, the derived stage from artifacts in step 2a,
the epic-continuity anchor as max-`updatedAt` `To Review`/`Done` ticket in step 3) and **git +
disk** (`production`/`esteira/<TICKET-ID>` for the merge, the
`.claude/esteira.lock.d` lock). Derivation rules 1–6, the Verdict/Status/Blockers regexes, the
lock/TTL and the recall/ingest best-effort behavior are all
unchanged — only the **retention** of already-consumed text changes.
