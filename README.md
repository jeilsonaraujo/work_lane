# Work Lane

Work Lane is an autonomous task pipeline where **Linear** tickets flow through stations —
understand → execution → review — each driven by its own agent. A local vector **knowledge
base** (`kb/`) gives those agents context and memory across tickets.

**Linear is the board / source of truth, and there is no service of your own to deploy.**
The pipeline lives entirely inside Claude Code plus a single local `.db` file.

## Overview

You don't drive Work Lane ticket-by-ticket. You design the lane and let it pull work on its
own. A ticket moves through the board like this:

```
Todo ─(pre-triage in place, auto)─► Triage ─(human: approve objective)─► In Progress ( understand → execution → review ) ─► To Review ─(human)─► Done
```

- **The lane self-starts.** WIP=1 applies **only to the active slot**; the pre-triage phase runs
  **in parallel**. Whenever there are eligible `Todo`s the lane pre-triages up to **3 per sweep**
  in place and moves each into `Triage` — no human is needed to *start* a ticket, and `Triage`
  (a **pure signal column**) never blocks the conveyor.
- **Two symmetric human gates.** At the **entry**, the `Triage` gate: the `triager` agent
  distills the ticket's **objective** into a `## 🎯 Pre-Triage` artifact **while it is still in
  `Todo`**, then the lane moves it to `Triage` and holds; you approve it by moving
  `Triage → In Progress` (or add a `## ⛔ Kick-back:` comment to bounce the objective, which
  re-triages it once). At the **exit**, the `To Review → Done` gate, where you validate the
  finished work. The lane does everything in between on its own.
- **Stations map to agents.** `triager` (pre-triage) → `context-builder` (understand) →
  `executor` (execution) → `reviewer` (review).
- **Artifacts are the source of truth.** Each station writes its result as a comment on the
  ticket: `## 🎯 Pre-Triage`, `## 🧭 Context Spec`, `## 🔧 Work Log`, `## 🔍 Review`. The
  driver derives the current stage from these artifacts, not from the label.

The orchestrator is the `/lane` skill (`.claude/skills/lane/SKILL.md`). One invocation runs
one sweep of the board; a loop wrapper turns it into a heartbeat. See `CLAUDE.md` for the full
state machine.

## Requirements

- **Node.js** — the repo pins the Node version via the root `.nvmrc` (`22.22.3`); run
  `nvm use` to match it. Minimum Node 20+. (`kb/package.json` does not declare an `engines`
  field — the `.nvmrc` is the version source.)
- **npm** — ships with Node.
- **Claude Code CLI** — Work Lane runs as Claude Code skills and agents.
- **A Linear account + workspace**, plus the **Linear MCP server** configured in Claude Code:

  ```bash
  claude mcp add --transport sse linear https://mcp.linear.app/sse
  ```

  Then complete the OAuth prompt to authenticate. This is what lets the agents read and write
  tickets, statuses, labels, and comments.
- **KB native dependencies** — the knowledge base builds `better-sqlite3` (a native module) and
  `sqlite-vec`. A one-time `npm install` inside `kb/` compiles them.
  (`@huggingface/transformers` is an optional dependency; the offline tests don't need it.)

## Linear board setup

The board lives in a Linear project (here named **Auto Lane**). The driver resolves statuses
and labels **by name on every sweep**, so the following names are a **contract — don't rename
them.** A missing canonical status aborts the sweep.

**Columns (statuses) that must exist, with these exact names:**

`Backlog` · `Todo` · `Triage` · `In Progress` · `To Review` · `Done` · `Canceled`

`Triage` is the **entry human gate** — a human-created workflow status between `Todo` and
`In Progress` (the Linear API can't create workflow statuses, so you add it by hand). Until it
exists the pre-triage gate is simply inert: the lane finds nothing in `Triage` and the rest of
the pipeline runs unchanged.

**Stage labels under a `stage` label group** (the entry gate + the sub-stations of `In Progress`):

`stage:triage` · `stage:understand` · `stage:execution` · `stage:review` · `stage:blocked`

The `stage:*` label is only a mirror of the derived stage; the artifacts (comments) remain the
real source of truth.

## Install

1. **Clone** the repository.
2. **Match the Node version:**

   ```bash
   nvm use            # uses the version in .nvmrc (22.22.3)
   ```
3. **Install the KB native dependencies** (one time):

   ```bash
   cd kb && npm install
   ```
4. **Seed the knowledge base:**

   ```bash
   node seed.mjs          # real embedding provider
   node seed.mjs --fake   # offline (fake provider, no model download)
   ```

   `seed.mjs` creates and populates `kb.db` (gitignored, anchored at the repo root —
   independent of your current directory). It's idempotent. This is the same file recall and
   ingest use by default.
5. **Configure the Linear MCP** in Claude Code (see Requirements):

   ```bash
   claude mcp add --transport sse linear https://mcp.linear.app/sse
   ```

## How to run

- **One sweep:**

  ```
  /lane
  ```
- **Heartbeat loop** (self-paced, or on a fixed interval):

  ```
  /loop /lane          # auto-paced
  /loop 15m /lane      # every 15 minutes
  ```

  Each heartbeat is a **stateless context unit** — start it from a fresh / compacted context.
  The lane reconstructs all cross-sweep state from Linear (coordinates, the derived stage from
  artifacts, the epic-continuity anchor) plus git/disk every sweep, and discards the active
  ticket's comment history and the subagent artifact bodies at the sweep boundary. So a
  long-running loop does **not** accumulate history (sustained context) between sweeps.

Only one driver runs at a time: each sweep acquires a mutual-exclusion lock before touching
Linear, so two simultaneous `/lane` runs never break the WIP=1 invariant (the second aborts
silently).

## Code driver (`lane/`) — a headless alternative to `/loop /lane`

The default driver is the prose `/lane` skill, which runs inside a Claude Code session and
talks to Linear through the **MCP server**. The repo also ships an **opt-in** deterministic
driver as a standalone Node package in `lane/` that encodes the same state machine in pure,
unit-tested modules and talks to Linear over its **GraphQL API** — **no MCP at runtime**.

- **Pure core (unit-tested, offline):** `lane/derive.mjs` (the derivation rules + the canonical
  Verdict/Status/Blockers regexes; recognizes `## 🎯 Pre-Triage` and the `## ⛔ Kick-back:`
  objective re-run, forward-only downstream), `lane/validate.mjs` (the pre-post format gate),
  `lane/decide.mjs` (returns a composite plan `{ active, pretriage[], reconcile[] }` — the WIP=1
  active In-Progress action plus up to `PRETRIAGE_CAP`=3 in-place pre-triages plus pending
  `move-to-triage` reconciles; `Triage` is a pure signal; ordering: epic-continuity → priority →
  number).
- **Thin I/O:** `lane/linear.mjs` (GraphQL client over global `fetch`, `LINEAR_API_KEY` from
  env), `lane/merge.mjs` (idempotent `esteira/<ID>` → `production` merge; a conflict returns a
  blocked signal, never auto-resolved), `lane/board.mjs` / `lane/post.mjs` (glue).
- **Runner:** `scripts/lane-tick.sh` is a `flock -n` single-instance wrapper that invokes the
  sweep (`node lane/run.mjs`) and dispatches the station workers in `.claude/commands/`
  (`/triage`, `/understand`, `/execute`, `/review`) via `claude -p`.

Run it:

```bash
cd lane && node --test                 # pure-logic unit tests (offline, no extra deps)
node lane/run.mjs --dry-run            # derive the next action from a fixture, NO side effects
scripts/lane-tick.sh --dry-run        # same, behind the flock single-instance guard
```

Set `LINEAR_API_KEY` in `.env` (see `.env.example`) for the live mode. The code driver is **not**
the default — the prose `/loop /lane` over the MCP remains the supported path; the live station
dispatch + posting wired in `scripts/lane-tick.sh` is the deliberately-deferred live-cutover layer.

## Artifact-comment language (`LANE_LANG`)

The repo itself is English-only, but the **human-readable prose** the lane writes into the
Linear comments (Context Spec / Work Log / Review) is language-configurable. The driver reads
the key `LANE_LANG` from a gitignored root `.env` at the start of each sweep:

```bash
cp .env.example .env     # then edit LANE_LANG
```

- **Accepted values:** `en` (default), `pt`, `pt-BR`. Anything unrecognized, empty, or a
  missing `.env` falls back to `en`.
- **`.env` is gitignored** (never versioned); `.env.example` is the committed template.
- **Only the prose is localized.** The protocol markers/headers (`## 🧭 Context Spec`,
  `## 🔧 Work Log`, `## 🔍 Review`) and the parsed fields
  (`**Blockers:**`, `**Status:** SUCCESS|FAILED`, `**Verdict:** APPROVED|REJECTED`) always
  stay verbatim in English — the state machine parses them with English-anchored regexes.

## How to run the tests

Everything runs offline with the fake embedding provider:

```bash
cd kb && KB_FAKE_EMBEDDINGS=1 npm test            # full suite (node --test)
cd kb && KB_FAKE_EMBEDDINGS=1 node e2e_smoke.mjs  # smoke: recall + ingest, before/after
```

If you switch Node versions and hit a `NODE_MODULE_VERSION` mismatch from the native module,
rebuild it:

```bash
cd kb && npm rebuild better-sqlite3
```

## Project layout

```
kb/                       Local vector knowledge base (the agents' memory)
  seed.mjs                  Build/populate kb.db from the repo docs
  recall.mjs                Query the KB (READ) → "## 📚 Relevant memory" block
  ingest.mjs                Write an artifact to the KB (WRITE)
  e2e_smoke.mjs             Offline smoke for recall + ingest
  index.js                  Library entry point
.claude/skills/lane/      The /lane orchestrator (SKILL.md = the prose driver)
.claude/agents/           The stations: triager.md, context-builder.md, executor.md, reviewer.md
.claude/commands/         Station workers for the code driver (/triage, /understand, /execute, /review)
lane/                     Opt-in code driver: pure derive/validate/decide + Linear/git I/O
  derive.mjs                Derivation rules + canonical regexes, incl. the entry pre-triage gate (PURE)
  validate.mjs              Pre-post format gate (PURE)
  decide.mjs                Composite plan: WIP=1 active slot + cap-3 in-place pre-triage + reconcile (PURE)
  linear.mjs                GraphQL client (global fetch, injectable)
  merge.mjs                 Idempotent esteira/<ID> → production merge
  run.mjs                   Sweep entrypoint (--dry-run prints the action, no side effects)
scripts/lane-tick.sh      flock single-instance runner for the code driver
CLAUDE.md                 Full project contract (state machine, handoffs, board IDs)
```
