// lane/run.mjs — sweep entrypoint for the code driver.
//
//   node lane/run.mjs --dry-run [--fixture board.json]
//       Pure, OFFLINE, NO side effects: load a board projection (a built-in sample
//       by default), derive the in-progress ticket's stage, run decide(), and print
//       the next action as JSON. Nothing is written to Linear or git.
//
//   node lane/run.mjs            (live — requires LINEAR_API_KEY)
//       Resolve coordinates, build the live board, decide the composite plan, print it,
//       and DISPATCH it (lane/dispatch.mjs): the station workers (claude -p), the posting
//       (lane/post.mjs) and the merge (lane/merge.mjs). The plan is always printed before
//       the dispatch mutates anything, so a live sweep stays inspectable in the logs.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { derive } from './derive.mjs';
import { decide } from './decide.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.resolve(__dirname, 'fixtures', 'board.sample.json');

// Drain backstop: the hard cap on stations chained in a single live invocation.
// understand → execution → review → merge is 4; 12 leaves generous headroom while
// bounding a pathological loop (the progress-signature guard normally stops first).
export const DRAIN_CAP = 12;

// A ticket has a SETTLED Pre-Triage when deriving its artifacts yields anything other
// than `triage` (no artifact / fresh kick-back both re-derive `triage`).
const hasPretriage = (artifacts) => derive(artifacts ?? []).stage !== 'triage';

// Reduce a raw fixture to the projection decide() expects. Fixture shape:
//   inProgress: { ticket, artifacts }              (optional)
//   todos:      [ { ...ticketFields, blockedBy, artifacts? } ]
//   triage:     [ { ticket, artifacts } ]          (tickets in the Triage column)
//   integrated: [ ... ]
// `artifacts` (when present) decide whether a ticket already carries a Pre-Triage.
export function projectFixture(fixture) {
  let inProgress = null;
  if (fixture.inProgress) {
    const { stage } = derive(fixture.inProgress.artifacts ?? []);
    inProgress = { ticket: fixture.inProgress.ticket, stage };
  }
  const todos = (fixture.todos ?? []).map((todo) => {
    const { artifacts, ...rest } = todo;
    return artifacts === undefined ? rest : { ...rest, hasPretriage: hasPretriage(artifacts) };
  });
  const triage = (fixture.triage ?? []).map((entry) => ({
    ...entry.ticket,
    hasPretriage: hasPretriage(entry.artifacts),
  }));
  return {
    inProgress,
    todos,
    triage,
    integrated: fixture.integrated ?? [],
  };
}

export function dryRun(fixturePath = DEFAULT_FIXTURE) {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const board = projectFixture(fixture);
  const plan = decide(board);
  return {
    mode: 'dry-run',
    fixture: fixturePath,
    inProgress: board.inProgress
      ? { ticket: board.inProgress.ticket.identifier, stage: board.inProgress.stage }
      : null,
    triageColumn: board.triage.map((t) => ({ ticket: t.identifier, hasPretriage: t.hasPretriage })),
    plan: {
      active: plan.active,
      pretriage: plan.pretriage.map((a) => ({ type: a.type, ticket: a.ticket.identifier, from: a.from })),
      reconcile: plan.reconcile.map((a) => ({ type: a.type, ticket: a.ticket.identifier })),
    },
  };
}

// The inspectable JSON view of a composite plan (same shape printed before dispatch
// since the single-action days) — emitted once per drain iteration so a live sweep
// stays auditable in the logs.
function livePlanView(plan) {
  return {
    mode: 'live',
    plan: {
      active: plan.active.ticket
        ? { type: plan.active.type, ticket: plan.active.ticket.identifier }
        : plan.active,
      pretriage: plan.pretriage.map((a) => ({ type: a.type, ticket: a.ticket.identifier, from: a.from })),
      reconcile: plan.reconcile.map((a) => ({ type: a.type, ticket: a.ticket.identifier })),
    },
  };
}

// Drain loop: repeat buildBoard → decide → dispatch WHILE the active slot advances,
// inside a single flock-held invocation. Each iteration RE-READS Linear and RE-DERIVES
// the stage from the freshly posted artifacts (stateless-per-sweep preserved) — it only
// removes the artificial cron-tick gap between stations, draining understand → execution
// → review → merge at once and stopping when the slot reaches idle.
//
// Pre-triage/reconcile run ONCE (iteration 0) so PRETRIAGE_CAP=3 stays per-sweep, not
// per-iteration. All deps are injectable so the loop is unit-testable fully offline.
export async function drain({
  buildBoard,
  decide: decideFn = decide,
  dispatch,
  client,
  projectId,
  statuses,
  labels,
  log = (msg) => process.stderr.write(`lane drain: ${msg}\n`),
  cap = DRAIN_CAP,
}) {
  let prevSignature; // undefined sentinel — "no previous iteration yet".
  let iterations = 0;
  // Guard 3 (cap): the for-bound is the backstop against a pathological non-converging loop.
  for (let i = 0; i < cap; i++) {
    iterations = i + 1;
    const board = await buildBoard({ client, projectId, statuses });
    const plan = decideFn(board);
    // Inspectable first: print the decided plan before dispatch mutates anything.
    console.log(JSON.stringify(livePlanView(plan), null, 2));

    // Progress signature of the active slot, BEFORE dispatch: ticket:stage (or null when idle).
    const signature = board.inProgress
      ? `${board.inProgress.ticket.identifier}:${board.inProgress.stage}`
      : null;

    // Guard 1 (progress signature): the active slot hasn't moved since the last iteration
    // (e.g. a valid artifact posted but the derived stage is unchanged — a skipped/looping
    // artifact). Stop rather than spin.
    if (i > 0 && signature === prevSignature) {
      log(`progress signature unchanged (${signature ?? 'idle'}) — stopping`);
      break;
    }
    prevSignature = signature;

    // Pre-triage/reconcile only on iteration 0; later iterations drain the active slot only.
    const iterPlan = i === 0 ? plan : { ...plan, pretriage: [], reconcile: [] };
    const { activeAdvanced } = await dispatch({ plan: iterPlan, client, statuses, labels });

    // Guard 2 (advance signal): the active slot didn't advance — idle, worker failure/
    // timeout, a rejected artifact, a merge conflict, or an unknown type. Nothing more to
    // drain this invocation.
    if (!activeAdvanced) {
      log(`active slot did not advance — stopping after ${iterations} iteration(s)`);
      break;
    }
  }
  return { iterations };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      fixture: { type: 'string' },
    },
  });

  if (values['dry-run']) {
    const out = dryRun(values.fixture ?? DEFAULT_FIXTURE);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Live mode (manual / scripts/lane-tick.sh): resolve coordinates, then DRAIN the active
  // slot — buildBoard → decide → dispatch repeated while the slot advances. The drain chains
  // understand → execution → review → merge in one flock-held invocation, so the cron is now
  // only a resilient resume heartbeat, not the engine that advances the epic tick-by-tick.
  const { createClient } = await import('./linear.mjs');
  const { buildBoard } = await import('./board.mjs');
  const { dispatch } = await import('./dispatch.mjs');
  const TEAM = '3c0058ed-759f-4678-b219-4d34d0f533d7';
  const PROJECT = '9a2f315c-8def-4698-ba9a-8d0a680cda13';
  const client = createClient();
  const statuses = await client.resolveStatuses(TEAM);
  const labels = await client.resolveLabels(TEAM);
  await drain({ buildBoard, decide, dispatch, client, projectId: PROJECT, statuses, labels });
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`lane run: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
