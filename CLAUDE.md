# Work Lane

Autonomous task pipeline where Linear tickets flow through stations, each one driven by a
responsible agent. Loop-Engineering philosophy: you don't prompt ticket-by-ticket — you
design the system (the lane) that does it for you.

**Linear is the board / source of truth.** A local vector knowledge base (`kb/`) gives the
agents context and memory. No service of your own to deploy.

## How it works

- **Board**: project **Auto Lane** in Linear (team `Lane`/`DIM`). Identify it **by ID** —
  names may change (see IDs below).
- **Columns (status)**: `Todo` → `Triage` → `In Progress` → `To Review` → `Done` (+ `Backlog`, `Canceled`).
- **Stations**: inside `In Progress`, a label from the `stage` group tells the sub-station (understand/execution/review/blocked). The entry gate `Triage` carries `stage:triage`.
- **Driver**: the `/lane` skill does ONE sweep. `/loop /lane` runs in a loop (heartbeat).
- **Two human gates (symmetric):** the **entry** gate `Triage` (a human validates the ticket's
  **objective** before the lane invests in a full plan) and the **exit** gate `To Review → Done`
  (a human validates the finished work). The lane does everything in between on its own.
- **Pre-triage (entry):** the `triager` agent distills a `Todo`'s objective once into a
  `## 🎯 Pre-Triage` artifact **while the ticket is still in `Todo`**; the lane then moves it
  `Todo → Triage`, where it **holds** as a pure signal (the human's turn). Up to **3 Todos are
  pre-triaged per sweep** (`PRETRIAGE_CAP`, independent of WIP=1). A human either **approves the
  objective** by moving it `Triage → In Progress` (the lane then runs `understand`), or adds a
  `## ⛔ Kick-back:` comment to **bounce the objective** — the only re-run. Pre-triage runs
  **once** per ticket; a `Todo` that already carries a Pre-Triage is just **moved** (not
  re-triaged — idempotency by artifact); execution/review kick-backs never return to it
  (forward-only is preserved downstream).
- **Auto-sequence (pre-triage):** the lane **keeps itself busy**. WIP=1 applies **only to the
  active slot**; the pre-triage phase runs **in parallel and is not gated by `Triage`**. Whenever
  there are eligible `Todo`s (all their `blockedBy` already **integrated** = in `To Review` or
  `Done`), the lane pre-triages up to **3 per sweep** in place and moves each into `Triage` — it
  does **not** wait for a human to START a ticket, nor for the active slot to free up, nor do
  `Triage` holds block it. Tickets in `To Review`/`blocked`/`Triage` wait for a human but don't
  occupy the active slot. Details in the `/lane` skill.
- **One driver at a time:** each sweep acquires a mutual-exclusion lock
  (`.claude/esteira.lock.d/`, atomic `mkdir`, TTL 30min) before touching Linear and
  releases it at the end. Two simultaneous `/lane` runs don't break WIP=1 — the 2nd aborts silently.
- **Stateless per sweep (sustained-cost boundary):** each `/loop /lane` heartbeat is a
  self-contained context unit and should start from a **fresh / compacted context**. The lane
  reconstructs ALL cross-sweep state from Linear (coordinates by name, the derived stage from
  artifacts, the epic-continuity anchor) + git/disk (`production`/branches, the lock) — it
  **never** relies on session memory. So the driver doesn't re-accumulate the active ticket's
  full comment history nor the subagent artifact bodies between heartbeats; they're discarded
  after each sweep (details in the `/lane` skill, "Per-sweep context boundary").

## State machine

**Source of truth = ARTIFACTS (comments), not the label.** The `stage:*` label is just a
mirror. The driver derives the stage from the ticket's comments, so a lost or wrong label
never causes regression/rework. "No label" ≠ "new"; new = no artifact.

Derived stage (most recent → oldest):
```
Review APPROVED        → integrate + move to status `To Review` (human gate)
Review REJECTED (<3)   → execution  | (>=3) → blocked
Work Log SUCCESS       → review
Work Log FAILED        → blocked
Context Spec (no block)→ execution  | (with blockers) → blocked
Kick-back (⛔, newer than Pre-Triage) → triage (objective re-run)
Pre-Triage (🎯, present)→ understand (objective settled; moved to Triage to await the gate)
no artifact            → triage (entry)
```

Flow: `Todo` (pre-triage **in place**; ⛔ kick-back re-runs it) ─(auto)─► `Triage` (pure signal
HOLD) ─(human: approve objective)─► `In Progress` → understand → execution → review →
(APPROVED, auto: merge + status) `To Review` ─(human)─► `Done`. The lane self-starts the
pre-triage and runs everything between the gates; humans only validate the **objective** (entry)
and the **result** (exit).

> **`triage` semantics, disambiguated by status (same pattern as `sign-off`+status):**
> a ticket in `Todo` deriving `triage` gets the **triager run in place** (then moves to `Triage`);
> a ticket in `Todo` deriving `understand` (a Pre-Triage is already posted) is just **moved to
> `Triage`** (reconcile, not re-triaged — idempotency by artifact); a ticket in `Triage` deriving
> `understand` is a **pure HOLD** (the lane runs nothing — the human's turn); a **legacy** ticket
> in `Triage` deriving `triage` (old model) is **triaged in place** and left there; a ticket in
> `In Progress` deriving `understand` runs the `understand` station.

Attempts = number of `## 🔍 Review` REJECTED comments. Limit: 3 → `blocked`.
**Branch base for review/merge: `production`.** The executor commits on `<TICKET-ID>`.
The executor's isolation worktree branches from the **local HEAD of `production`** via
`worktree.baseRef: "head"` in `.claude/settings.json` (the key only accepts `"fresh"` or
`"head"`). Reason: there is no resolvable `origin/HEAD` and the integrated code lives only in
the local `production` — the default `"fresh"` would lose the already-merged tickets.

| Event | Lane action |
|---|---|
| Review APPROVED | **auto, in the same sweep:** merge `<TICKET-ID>` → `production` (idempotent), **move the ticket to `To Review`** and **set the green terminal label `stage:done`** (mutually exclusive in the `stage` group — replaces the stale `stage:*`). The queue does **not** wait for you. |
| you move `To Review` → `Done` | just closes the ticket (the merge already happened) |
| problem found after merge | **forward-only:** a merged ticket is terminal — the lane never reopens nor reverts it. File a **NEW linked ticket** (regression/bugfix) that flows through the lane normally. An emergency revert of a bad merge is a rare, **manual, human action** — not automated by the lane. |

**Autonomy & WIP=1:** the lane runs the whole epic on its own, stacking the tickets in
`To Review` for you to validate whenever you want. It only stops on a **real block** (`blocked`) or
when there is no eligible `Todo`. Invariant: **a single active task at a time**.

## Handoffs (artifacts as comments on the ticket)

Each station records its result as a comment on the ticket, with a standard header:
- `## 🎯 Pre-Triage` — objective (what & why), brief overview, tradeoffs/open questions (each
  with an explicit assumed default). **No parsed enum field** — the gate is the `Triage`
  status validated by a human.
- `## 🧭 Context Spec` — scope, affected files, approach, acceptance criteria, test plan.
- `## 🔧 Work Log` — what the executor did, branch/diff, tests run.
- `## 🔍 Review` — verdict (APPROVED/REJECTED) + justification against the criteria.

A human can also add a `## ⛔ Kick-back:` comment on a ticket parked in `Triage` to bounce its
objective: a kick-back newer than the last `## 🎯 Pre-Triage` re-runs the triager once.

## Knowledge base (`kb/`) — the agents' memory

The `kb/` is the local vector memory layer (sqlite-vec + local-first embeddings via
`transformers.js`). It's a local library — a single `.db` file
(`kb.db`, gitignored), **no service**.

The driver uses the KB at two moments per ticket (read + write):
- **Recall** (before triggering the station): queries the KB and injects a
  `## 📚 Relevant memory` block into the agent's prompt. *(wiring in WLN-19)*
- **Ingest** (after posting the artifact to Linear): writes Context Spec / Work Log /
  Review to the KB, with `kind`/`stage`/`source` tags, idempotently. *(wiring in WLN-20)*

> The `kb/recall.mjs` and `kb/ingest.mjs` CLIs are the surface the driver calls (WLN-17).
> Until the wiring lands, the lane runs over Linear alone (like v1).

## Linear IDs (the lane's coordinates)

**Team and Project are stable anchors — always use the ID.** The **status and labels are
resolved by NAME on every sweep** (step 0 of the `/lane` skill, via `list_issue_statuses`
+ `list_issue_labels`): the ID table below is only **cache/fallback**. If the board is
reordered/recreated the IDs change, and the driver switches to using the live IDs (reporting the
divergence) without breaking the sweep.

> **Canonical names = contract (do not rename).** The columns `Todo` / `Triage` / `In Progress` /
> `To Review` / `Done` / `Canceled` and the labels `stage:triage` / `stage:understand` /
> `stage:execution` / `stage:review` / `stage:blocked` / `stage:done` are resolved by these exact
> names on every sweep. (`stage:done` is the green **terminal** label set on integration — not a
> derived stage.) Renaming any of them breaks resolution: a missing canonical status **aborts the
> sweep**; a missing `stage:*` label falls back to the hardcoded ID below + warning.
> **`Triage` is a human-created column** (the Linear API can't create a workflow status) — until
> it exists the entry pre-triage gate is inert (the driver simply finds nothing in `Triage`).

- Team (current: "Lane", key DIM): `3c0058ed-759f-4678-b219-4d34d0f533d7`
- Project (current: "Auto Lane"): `9a2f315c-8def-4698-ba9a-8d0a680cda13`
- Epic: **WLN-14**

Status — **cache/fallback (resolved by name on every sweep)** (⚠️ "To Review" reused the ID of the old "Done"; "Done" is now a new ID):
- Todo: `c7b52570-af37-4d8e-abd3-95d927cae20c`
- **Triage: `TODO-fill-after-human-creates-the-column`** (entry pre-triage gate; a human must
  create this workflow status in Linear between `Todo` and `In Progress` — the Linear API does
  **not** expose workflow-status creation. Until then it resolves by name on the sweep and, if
  absent, the gate stays inert. Do **not** invent a fake ID here.)
- In Progress: `e26d59a8-f02e-4959-ae24-ee57e81f4534`
- **To Review: `8f89ea97-e4c4-4625-a29a-56aab536363f`** (was the ID of the old "Done")
- **Done (new): `be50bf53-88ac-4021-8bdf-774695cff007`**
- Canceled: `74f37c47-98d8-47a8-a7e7-f7936f4bc207`

Labels — **cache/fallback (resolved by name on every sweep)** (`stage` group = `9e921002-79e5-4435-92af-b2f42025b724`) — sub-stations of `In Progress` (+ the `Triage` entry gate):
- stage:triage: `TODO-fill-after-human-creates-the-label` (entry pre-triage; create under the `stage` group — falls back by name, warns if absent)
- stage:understand: `c1e0dfb5-423f-49c5-915b-686c025b1dd7`
- stage:execution: `58c3331f-3539-4e5b-b13f-16a9601aea0b`
- stage:review: `e948cf81-3414-4c55-a62d-c7c9192e5db7`
- stage:blocked: `649682c6-fec8-400b-8760-5453ea25eaae`
- **stage:done: `00b16b79-fdd4-44c0-8fed-c89a83de8e01`** (color `#4cb782`, the green of the
  old `stage:sign-off`) — green **terminal** label set when a ticket is integrated and moved to
  `To Review` (steps c2/e). Create it under the `stage` group; resolves by name each sweep and, if
  absent, the merge+`To Review` move still happens — only the label is skipped (warning).
- *(stage:sign-off `b862a7e9-0150-4159-8998-3d70eff5555b` — **deprecated**: replaced by the
  `To Review` status; its green is inherited by the terminal `stage:done` above.)*

## How to run

**1. Prepare the memory (`kb/`) — once:**

```bash
cd kb && npm install            # better-sqlite3 + sqlite-vec (once)
node seed.mjs                    # populates kb.db with the repo docs (real provider)
node seed.mjs --fake           # ...or offline (fake provider, no model download)
```

`seed.mjs` creates/populates `kb.db` (gitignored) **anchored at the repo root** (default
resolved by the script itself, independent of the CWD) — the SAME file that recall/ingest
use by default (step 3). Idempotent.

**2. Run the lane:**

- One pass: `/lane`
- In a loop: `/loop /lane` (no interval = self-paced) or `/loop 15m /lane`

Each heartbeat is **stateless-per-sweep**: start it from a fresh / compacted context. The lane
rebuilds everything from Linear + git/disk every sweep and discards the active ticket's comment
history and the subagent artifact bodies at the sweep boundary, so a long-running `/loop` does
**not** accumulate sustained context across heartbeats.

**3. Recall + ingest on the SAME default `kb.db`.** The driver calls `kb/recall.mjs` (READ →
injects `## 📚 Relevant memory` into the prompt) and `kb/ingest.mjs` (WRITE) **without** `--db`:
both resolve `kb.db` **anchored at the repo root** (independent of the CWD). Don't pass
`--db` (see `d.0`/`d.1` in the SKILL).

**Smoke (offline evidence of recall + ingest):**

```bash
cd kb && KB_FAKE_EMBEDDINGS=1 node e2e_smoke.mjs   # memory block + before/after
cd kb && KB_FAKE_EMBEDDINGS=1 npm test             # full suite, offline
```

**Code driver (`lane/`) — headless alternative to `/loop /lane`.** Besides the prose
`/lane` skill (which drives the board through the Linear **MCP** inside a Claude Code
session), the repo ships an **opt-in** deterministic driver as a standalone Node package
in `lane/` — **no MCP at runtime**. It encodes the same state machine in pure, unit-tested
modules and talks to Linear over the GraphQL API:

- `lane/derive.mjs` — PURE port of the derivation rules + the canonical Verdict/Status/Blockers
  regexes (forward-only downstream; recognizes `## 🎯 Pre-Triage` and the `## ⛔ Kick-back:`
  objective re-run). `lane/validate.mjs` — the d.0.6 pre-post format gate (incl. the header-only
  `triage` validator). `lane/decide.mjs` — returns a **composite plan**
  `{ active, pretriage:[…], reconcile:[…] }`: the WIP=1 active In-Progress action **plus** up to
  `PRETRIAGE_CAP` (=3) in-place pre-triages **plus** any pending `move-to-triage` reconciles
  (a `Todo` that already has a Pre-Triage). `Triage` is a **pure signal** (no action). Ordering:
  epic-continuity → priority → number.
- `lane/linear.mjs` — thin GraphQL client (global `fetch`, `LINEAR_API_KEY` from env).
  `lane/merge.mjs` — idempotent `<ID>` → `production` merge (is-ancestor guard;
  conflict → blocked signal, never auto-resolved). `lane/board.mjs` / `lane/post.mjs` — glue.
- `lane/run.mjs --dry-run` — derives the next action from a board fixture and prints it with
  **zero side effects** (offline; no Linear/git writes). The **live** path is a **drain loop**
  (`drain()`, `DRAIN_CAP=12`): it repeats `buildBoard → decide → dispatch` **while the active
  slot advances**, chaining `understand → execution → review → merge` in a single `flock`-held
  invocation and stopping at `idle`, on an unchanged progress signature (`ticket:stage`), or at
  the cap. Each iteration re-reads Linear and re-derives from artifacts, so `stateless-per-sweep`
  holds; it only removes the artificial cron-tick gap between stations. Pre-triage/reconcile run
  **once** (iteration 0) so `PRETRIAGE_CAP=3` stays per-sweep. `dispatch()` returns
  `{ activeAdvanced }` as the loop's stop signal. `scripts/lane-tick.sh` — `flock -n`
  single-instance runner that invokes the drain and dispatches the station workers in
  `.claude/commands/` (`/triage`, `/understand`, `/execute`, `/review`) via `claude -p`.
  With the drain self-chaining the stations, the **cron is now a resume heartbeat** (wakes the
  lane after a mid-drain death — credits/rate-limit, killed `claude -p`, OOM, reboot — or when a
  human opens a gate), not the engine; the happy path is interval-independent, so **~10min** is
  recommended (the live crontab interval is a manual `crontab -e` step, outside the repo).
- Tests: `cd lane && node --test` (pure-logic coverage, fully offline, no extra deps).
- Config: set `LINEAR_API_KEY` in `.env` (see `.env.example`). The code driver is **not** the
  default — the prose `/loop /lane` over the MCP remains the supported path; the live station
  dispatch + posting in `scripts/lane-tick.sh` is the deferred live-cutover layer.

**Artifact-comment language (`LANE_LANG`).** The human-readable PROSE the lane writes into
Linear comments (Context Spec / Work Log / Review) is language-configurable via a gitignored
root `.env` key `LANE_LANG` (default `en`; accepted `en`/`pt`/`pt-BR`; unrecognized/empty/missing
→ `en`). `cp .env.example .env` and edit it; `.env.example` is the committed template. The
driver resolves it at sweep start (step 0.6 of the `/lane` skill) and threads it into every
station prompt. **Only prose is localized** — the protocol markers/headers (`## 🧭 Context Spec`
/ `## 🔧 Work Log` / `## 🔍 Review`) and the parsed fields (`**Blockers:**`
/ `**Status:** SUCCESS|FAILED` / `**Verdict:** APPROVED|REJECTED`) stay verbatim in English, since
the state machine parses them with English-anchored regexes.
