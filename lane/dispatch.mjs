// lane/dispatch.mjs — the LIVE cutover layer of the code driver: turn a composite
// plan from decide() into the actual station runs + Linear writes + git merge.
//
// ALL side-effect dependencies are INJECTABLE (same pattern as linear.mjs/merge.mjs/
// post.mjs) so the dispatcher is unit-testable fully offline: `runClaude` (the headless
// worker), `client` (Linear), `post` (validate → comment → ingest → status/label),
// `merge` (git), `log`. Nothing here runs `claude -p` in tests.
//
// Order per sweep:  active → reconcile → pretriage (capped upstream by decide()).
// Robustness contract: NO exception escapes dispatch(). A failure on any single action
// (worker error/timeout, invalid artifact, post failure, merge conflict) is logged and
// the sweep CONTINUES — `active` is attempted first and its failure never aborts the rest.
// The d.0.6 format gate is preserved: validation lives in post.mjs, which refuses to
// comment/ingest a malformed artifact, so derivation never sees a bad field.

import { spawnSync } from 'node:child_process';
import { post as defaultPost } from './post.mjs';
import { merge as defaultMerge } from './merge.mjs';

// Headless worker timeout (ms). A station run (recall + role + artifact) can take a
// while; default mirrors the lock TTL (30 min). Override via LANE_CLAUDE_TIMEOUT_MS.
export const DEFAULT_TIMEOUT_MS = Number(process.env.LANE_CLAUDE_TIMEOUT_MS) || 30 * 60 * 1000;

// active.type → { cmd (the /command), station (validate/post + KB kind key) }.
// Note the asymmetry: the `execution` stage is run by the `/execute` command.
const STATION = {
  understand: { cmd: 'understand', station: 'understand' },
  execution: { cmd: 'execute', station: 'execution' },
  review: { cmd: 'review', station: 'review' },
};

// Default headless runner: `claude -p "/<cmd> wln=<num>"`, capturing stdout (the worker
// prints ONLY the artifact — the contract of .claude/commands/*.md). Returns the raw
// spawnSync result ({ status, signal, stdout, stderr, error }).
export function defaultRunClaude({ cmd, num, timeout = DEFAULT_TIMEOUT_MS }) {
  return spawnSync('claude', ['-p', `/${cmd} wln=${num}`], { encoding: 'utf8', timeout });
}

// A worker run "failed" when the process errored, was killed (signal), or exited non-zero.
function workerFailed(res) {
  if (!res) return 'no result';
  if (res.error) return `spawn error: ${res.error.message || res.error}`;
  if (res.signal) return `killed by signal ${res.signal}`;
  if (res.status !== 0) return `exit status ${res.status}`;
  return null;
}

// Dispatch one station worker, then post its artifact. Returns the post result (or
// undefined on a worker failure). Never throws — failures are logged and swallowed.
async function runStation({ cmd, station, ticket, client, runClaude, post, log, stateId, labelId }) {
  const res = runClaude({ cmd, num: ticket.number });
  const fail = workerFailed(res);
  if (fail) {
    log(`/${cmd} wln=${ticket.number} (${ticket.identifier}) ${fail} — skipping`);
    return undefined;
  }
  const r = await post({
    client,
    station,
    body: res.stdout,
    issueId: ticket.id,
    ticketId: ticket.identifier,
    stateId,
    labelId,
  });
  if (!r || !r.ok) {
    log(`post ${ticket.identifier} (${station}) rejected: ${r ? r.error : 'no result'} — skipping`);
  }
  return r;
}

// active.type === 'merge': NO worker — idempotent git merge, then move To Review +
// stage:done (forward-only on conflict: just log, leave for a human).
async function dispatchMerge({ ticket, client, statuses, labels, merge, log }) {
  const branch = `esteira/${ticket.identifier}`;
  const r = merge(branch);
  if (r.ok && !r.blocked) {
    await client.updateIssue(ticket.id, {
      stateId: statuses['To Review'],
      labelIds: labels['stage:done'] ? [labels['stage:done']] : undefined,
    });
    log(`merged ${branch} → production; ${ticket.identifier} → To Review (stage:done)`);
  } else {
    log(`merge ${branch} blocked: ${r.reason} — forward-only, left for a human`);
  }
}

export async function dispatch({
  plan,
  client,
  statuses = {},
  labels = {},
  runClaude = defaultRunClaude,
  post = defaultPost,
  merge = defaultMerge,
  log = (msg) => process.stderr.write(`lane dispatch: ${msg}\n`),
} = {}) {
  const active = (plan && plan.active) || { type: 'idle' };
  const reconcile = (plan && plan.reconcile) || [];
  const pretriage = (plan && plan.pretriage) || [];

  // 1. ACTIVE (WIP=1) — dispatched first; a failure here must NOT abort the sweep.
  try {
    if (active.type === 'idle') {
      // nothing to run on the active slot this sweep.
    } else if (active.type === 'merge') {
      await dispatchMerge({ ticket: active.ticket, client, statuses, labels, merge, log });
    } else if (STATION[active.type]) {
      const { cmd, station } = STATION[active.type];
      await runStation({ cmd, station, ticket: active.ticket, client, runClaude, post, log });
    } else {
      log(`unknown active type "${active.type}" — skipping`);
    }
  } catch (e) {
    log(`active (${active.type}) threw: ${e && e.message ? e.message : e} — continuing`);
  }

  // 2. RECONCILE — Todos that already carry a Pre-Triage: just move Todo → Triage
  //    (NO worker, idempotent by artifact).
  for (const action of reconcile) {
    try {
      if (action.type === 'move-to-triage') {
        await client.updateIssue(action.ticket.id, { stateId: statuses['Triage'] });
        log(`reconcile: ${action.ticket.identifier} → Triage`);
      }
    } catch (e) {
      log(`reconcile ${action.ticket && action.ticket.identifier} threw: ${e && e.message ? e.message : e} — continuing`);
    }
  }

  // 3. PRE-TRIAGE — run /triage; from:'Todo' moves the ticket to Triage AFTER a
  //    successful post; from:'Triage' (legacy) is triaged in place, no move.
  for (const action of pretriage) {
    try {
      const r = await runStation({
        cmd: 'triage',
        station: 'triage',
        ticket: action.ticket,
        client,
        runClaude,
        post,
        log,
      });
      if (r && r.ok && action.from === 'Todo') {
        await client.updateIssue(action.ticket.id, { stateId: statuses['Triage'] });
        log(`pretriage: ${action.ticket.identifier} posted + moved Todo → Triage`);
      }
    } catch (e) {
      log(`pretriage ${action.ticket && action.ticket.identifier} threw: ${e && e.message ? e.message : e} — continuing`);
    }
  }
}
