# Work Lane

Autonomous task pipeline where Linear tickets flow through stations, each one driven by a
responsible agent. Loop-Engineering philosophy: you don't prompt ticket-by-ticket — you
design the system (the lane) that does it for you.

**Linear is the board / source of truth.** A local vector knowledge base (`kb/`) gives the
agents context and memory. No service of your own to deploy.

## How it works

- **Board**: project **Auto Lane** in Linear (team `Lane`/`DIM`). Identify it **by ID** —
  names may change (see IDs below).
- **Columns (status)**: `Todo` → `In Progress` → `To Review` → `Done` (+ `Backlog`, `Canceled`).
- **Stations**: inside `In Progress`, a label from the `stage` group tells the sub-station (understand/execution/review/blocked).
- **Driver**: the `/lane` skill does ONE sweep. `/loop /lane` runs in a loop (heartbeat).
- **Human gate**: only the **exit** (`To Review` → `Done`). Entry is automatic.
- **Auto-sequence (pull):** the lane is WIP=1 and **keeps itself busy**. Whenever there is no
  active ticket and an eligible `Todo` exists (all its `blockedBy` already **integrated** = in
  `To Review` or `Done`), it pulls the next one on its own — **without** waiting for a human entry gate.
  Tickets in `To Review`/`blocked` wait for a human but don't occupy the slot. Details in the `/lane` skill.
- **One driver at a time:** each sweep acquires a mutual-exclusion lock
  (`.claude/esteira.lock.d/`, atomic `mkdir`, TTL 30min) before touching Linear and
  releases it at the end. Two simultaneous `/lane` runs don't break WIP=1 — the 2nd aborts silently.

## State machine

**Source of truth = ARTIFACTS (comments), not the label.** The `stage:*` label is just a
mirror. The driver derives the stage from the ticket's comments, so a lost or wrong label
never causes regression/rework. "No label" ≠ "new"; new = no artifact.

Derived stage (most recent → oldest):
```
Kick-back (⛔)          → invalidates artifacts < the kick-back's createdAt; reverts merge + reopens at understand (cap 2 → blocked)
Review APPROVED        → integrate + move to status `To Review` (human gate)
Review REJECTED (<3)   → execution  | (>=3) → blocked
Work Log SUCCESS       → review
Work Log FAILED        → blocked
Context Spec (no block)→ execution  | (with blockers) → blocked
no artifact            → understand (entry)
```

Flow: `Todo ─(auto)─► In Progress` → understand → execution → review →
(APPROVED, auto: merge + status) `To Review` ─(human)─► `Done`. Entry is automatic; human gate only on exit.

Attempts = number of `## 🔍 Review` REJECTED comments. Limit: 3 → `blocked`.
**Branch base for review/merge: `production`.** The executor commits on `esteira/<TICKET-ID>`.
The executor's isolation worktree branches from the **local HEAD of `production`** via
`worktree.baseRef: "head"` in `.claude/settings.json` (the key only accepts `"fresh"` or
`"head"`). Reason: there is no resolvable `origin/HEAD` and the integrated code lives only in
the local `production` — the default `"fresh"` would lose the already-merged tickets.

| Event | Lane action |
|---|---|
| Review APPROVED | **auto, in the same sweep:** merge `esteira/<TICKET-ID>` → `production` (idempotent) **and move the ticket to `To Review`**. The queue does **not** wait for you. |
| you move `To Review` → `Done` | just closes the ticket (the merge already happened) |
| you reject: move `To Review`/`Done` → `Todo` + comment `## ⛔ Kick-back: <reason>` | **auto (idempotent):** the kick-back invalidates the previous artifacts (createdAt < its own), reverts the merge on `production` (`git revert -m 1`), and reopens the ticket in `In Progress`/`understand` passing the `<reason>` to the context-builder. Moving the status is not enough — the artifact is the truth. Anti-loop: 2 kick-backs → `blocked`. |

**Autonomy & WIP=1:** the lane runs the whole epic on its own, stacking the tickets in
`To Review` for you to validate whenever you want. It only stops on a **real block** (`blocked`) or
when there is no eligible `Todo`. Invariant: **a single active task at a time**.

## Handoffs (artifacts as comments on the ticket)

Each station records its result as a comment on the ticket, with a standard header:
- `## 🧭 Context Spec` — scope, affected files, approach, acceptance criteria, test plan.
- `## 🔧 Work Log` — what the executor did, branch/diff, tests run.
- `## 🔍 Review` — verdict (APPROVED/REJECTED) + justification against the criteria.

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

> **Canonical names = contract (do not rename).** The columns `Todo` / `In Progress` /
> `To Review` / `Done` / `Canceled` and the labels `stage:understand` / `stage:execution` /
> `stage:review` / `stage:blocked` are resolved by these exact names on every sweep.
> Renaming any of them breaks resolution: a missing canonical status **aborts the sweep**;
> a missing `stage:*` label falls back to the hardcoded ID below + warning.

- Team (current: "Lane", key DIM): `3c0058ed-759f-4678-b219-4d34d0f533d7`
- Project (current: "Auto Lane"): `9a2f315c-8def-4698-ba9a-8d0a680cda13`
- Epic: **WLN-14**

Status — **cache/fallback (resolved by name on every sweep)** (⚠️ "To Review" reused the ID of the old "Done"; "Done" is now a new ID):
- Todo: `c7b52570-af37-4d8e-abd3-95d927cae20c`
- In Progress: `e26d59a8-f02e-4959-ae24-ee57e81f4534`
- **To Review: `8f89ea97-e4c4-4625-a29a-56aab536363f`** (was the ID of the old "Done")
- **Done (new): `be50bf53-88ac-4021-8bdf-774695cff007`**
- Canceled: `74f37c47-98d8-47a8-a7e7-f7936f4bc207`

Labels — **cache/fallback (resolved by name on every sweep)** (`stage` group = `9e921002-79e5-4435-92af-b2f42025b724`) — sub-stations of `In Progress`:
- stage:understand: `c1e0dfb5-423f-49c5-915b-686c025b1dd7`
- stage:execution: `58c3331f-3539-4e5b-b13f-16a9601aea0b`
- stage:review: `e948cf81-3414-4c55-a62d-c7c9192e5db7`
- stage:blocked: `649682c6-fec8-400b-8760-5453ea25eaae`
- *(stage:sign-off `b862a7e9-0150-4159-8998-3d70eff5555b` — **deprecated**: replaced by the `To Review` status.)*

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

**3. Recall + ingest on the SAME default `kb.db`.** The driver calls `kb/recall.mjs` (READ →
injects `## 📚 Relevant memory` into the prompt) and `kb/ingest.mjs` (WRITE) **without** `--db`:
both resolve `kb.db` **anchored at the repo root** (independent of the CWD). Don't pass
`--db` (see `d.0`/`d.1` in the SKILL).

**Smoke (offline evidence of recall + ingest):**

```bash
cd kb && KB_FAKE_EMBEDDINGS=1 node e2e_smoke.mjs   # memory block + before/after
cd kb && KB_FAKE_EMBEDDINGS=1 npm test             # full suite, offline
```

**Artifact-comment language (`LANE_LANG`).** The human-readable PROSE the lane writes into
Linear comments (Context Spec / Work Log / Review) is language-configurable via a gitignored
root `.env` key `LANE_LANG` (default `en`; accepted `en`/`pt`/`pt-BR`; unrecognized/empty/missing
→ `en`). `cp .env.example .env` and edit it; `.env.example` is the committed template. The
driver resolves it at sweep start (step 0.6 of the `/lane` skill) and threads it into every
station prompt. **Only prose is localized** — the protocol markers/headers (`## 🧭 Context Spec`
/ `## 🔧 Work Log` / `## 🔍 Review` / `## ⛔ Kick-back:`) and the parsed fields (`**Blockers:**`
/ `**Status:** SUCCESS|FAILED` / `**Verdict:** APPROVED|REJECTED`) stay verbatim in English, since
the state machine parses them with English-anchored regexes.
