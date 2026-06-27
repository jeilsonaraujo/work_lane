# Changelog

All notable changes to the Work Lane are documented here.

## [0.1.0] — 2026-06-27

First release of the **Work Lane**: an autonomous task pipeline where Linear tickets flow
through stations, each driven by a responsible agent. Linear is the board / source of truth;
a local vector KB gives the agents memory. No service to deploy.

### Added

- **Autonomous lane over Linear.** Project *Auto Lane* (team `Lane`/`DIM`) as the board, with
  the `/lane` skill running one sweep and `/loop /lane` running as a heartbeat. WIP=1 on the
  active slot; the lane self-starts and runs everything between the two human gates.
- **State machine driven by artifacts, not labels.** Stage is derived from the ticket's comments
  (`## 🎯 Pre-Triage`, `## 🧭 Context Spec`, `## 🔧 Work Log`, `## 🔍 Review`); the `stage:*`
  label is only a mirror, so a lost or wrong label never causes regression.
- **Stations as agents:** `triager` (pre-triage), `context-builder` (understand), `executor`
  (execution), `reviewer` (review) — each posts a standard artifact comment as its handoff.
- **Two symmetric human gates:** entry objective approval (`Triage` → `In Progress`) and exit
  result approval (`To Review` → `Done`).
- **Pre-triage entry gate + auto-sequence.** The lane distills a Todo's objective once into a
  Pre-Triage artifact (up to 3 per sweep, independent of WIP=1), moves it to the `Triage` signal
  column, and keeps itself busy with eligible Todos without waiting for a human to start a ticket.
  A `## ⛔ Kick-back:` comment bounces the objective — the only re-run.
- **Knowledge base (`kb/`).** Local-first vector memory (sqlite-vec + `transformers.js`), a single
  gitignored `kb.db`, no service. `seed.mjs` (real or `--fake` provider), plus `recall.mjs` /
  `ingest.mjs` CLIs and an offline e2e smoke test.
- **Deterministic code driver (`lane/`).** Opt-in headless alternative to `/loop /lane` — pure,
  unit-tested modules (`derive`, `validate`, `decide`, `linear`, `merge`, `board`, `post`) talking
  to Linear over GraphQL (no MCP at runtime). `run.mjs --dry-run` for offline derivation;
  `scripts/lane-tick.sh` as a `flock`-guarded single-instance runner.
- **Mutual-exclusion lock.** Each sweep acquires `.claude/esteira.lock.d/` (atomic `mkdir`,
  30min TTL) so two simultaneous runs can't break WIP=1.
- **Configurable comment language (`LANE_LANG`).** Prose in Linear comments is localizable
  (`en` default, `pt`/`pt-BR`); protocol markers and parsed fields stay verbatim in English.

### Changed

- **Forward-only integration.** On review APPROVED the lane merges `<TICKET-ID>` → `production`
  (idempotent), moves the ticket to `To Review`, and sets the green terminal `stage:done` label,
  all in the same sweep. A merged ticket is terminal — problems found later become a new linked
  ticket, never a reopen.
- **Trunk-based branch policy.** Every branch the lane creates is cut from the integration trunk
  (`production`/`main`), never from another in-progress branch; the executor worktree uses
  `worktree.baseRef: "head"`.
- **Stateless-per-sweep.** Each heartbeat is self-contained: the lane rebuilds all cross-sweep
  state from Linear + git/disk and discards comment history and artifact bodies at the sweep
  boundary, so a long `/loop` doesn't accumulate context.
- **Live drain loop.** The code driver chains `understand → execution → review → merge` in one
  `flock`-held invocation (`DRAIN_CAP=12`), making the cron a resume heartbeat rather than the
  engine; ~10min interval recommended.
- **Linear coordinates resolved by name each sweep.** Team/Project are stable ID anchors; statuses
  and `stage:*` labels are resolved by their canonical names (with cached IDs as fallback).
- **Full English migration.** Driver, protocol, and docs migrated to English; the lane is now
  fully project-agnostic (no project content ever committed to the lane repo).

### Fixed

- Drain-loop, parsing, and dispatch hardening (`6e1a7b0`).
- Retrieval & driver hardening (`11c1be5`).
