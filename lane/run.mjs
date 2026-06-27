// lane/run.mjs — sweep entrypoint for the code driver.
//
//   node lane/run.mjs --dry-run [--fixture board.json]
//       Pure, OFFLINE, NO side effects: load a board projection (a built-in sample
//       by default), derive the in-progress ticket's stage, run decide(), and print
//       the next action as JSON. Nothing is written to Linear or git.
//
//   node lane/run.mjs            (live — requires LINEAR_API_KEY)
//       Resolve coordinates, build the live board, and print the decided action.
//       The actual station dispatch (claude -p "/understand wln=N"), the posting
//       (lane/post.mjs) and the merge (lane/merge.mjs) are the live-cutover layer
//       wired by scripts/lane-tick.sh; this entrypoint stops at the decision so a
//       sweep is always inspectable before it mutates anything.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { derive } from './derive.mjs';
import { decide } from './decide.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.resolve(__dirname, 'fixtures', 'board.sample.json');

// Reduce a raw fixture (inProgress.artifacts) to the projection decide() expects.
export function projectFixture(fixture) {
  let inProgress = null;
  if (fixture.inProgress) {
    const { stage } = derive(fixture.inProgress.artifacts ?? []);
    inProgress = { ticket: fixture.inProgress.ticket, stage };
  }
  return {
    inProgress,
    todos: fixture.todos ?? [],
    integrated: fixture.integrated ?? [],
  };
}

export function dryRun(fixturePath = DEFAULT_FIXTURE) {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const board = projectFixture(fixture);
  const action = decide(board);
  return {
    mode: 'dry-run',
    fixture: fixturePath,
    inProgress: board.inProgress
      ? { ticket: board.inProgress.ticket.identifier, stage: board.inProgress.stage }
      : null,
    action,
  };
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

  // Live mode (manual / scripts/lane-tick.sh) — kept minimal, no inline mutations.
  const { createClient } = await import('./linear.mjs');
  const { buildBoard } = await import('./board.mjs');
  const TEAM = '3c0058ed-759f-4678-b219-4d34d0f533d7';
  const PROJECT = '9a2f315c-8def-4698-ba9a-8d0a680cda13';
  const client = createClient();
  const statuses = await client.resolveStatuses(TEAM);
  const board = await buildBoard({ client, projectId: PROJECT, statuses });
  const action = decide(board);
  console.log(JSON.stringify({ mode: 'live', action }, null, 2));
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`lane run: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
