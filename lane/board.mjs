// lane/board.mjs — `lane-sync`: build the board projection consumed by decide().
//
// Thin glue: it asks the Linear client for the live state and reduces it to the
// shape decide.mjs expects. ALL logic stays in the pure modules (derive/decide).
//
// Returns: { inProgress: {ticket, stage}|null,
//            todos:[ {..., hasPretriage?} ],
//            triage:[ {..., hasPretriage} ],   // tickets currently in the Triage column
//            integrated:[...] }
//
// Pre-triage runs WHILE a ticket is still in `Todo`; `Triage` is a pure signal column
// (a ticket lands there only AFTER its `## 🎯 Pre-Triage` is posted, awaiting the human
// objective gate). So the projection carries, per ticket, whether it already has a
// settled Pre-Triage (`hasPretriage`) — derived from its comments. To bound cost we only
// hydrate `hasPretriage` for the ordered/capped Todo candidates (the ones decide() may act
// on this sweep); the rest keep it absent.

import { derive } from './derive.mjs';
import { eligibleTodos, orderTodos, PRETRIAGE_CAP } from './decide.mjs';

// Map a Linear comment { id, body, createdAt } to the projection derive() needs:
// the header line is just the first non-empty line of the body.
function projectArtifact(comment) {
  const body = comment.body ?? '';
  const header = (body.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  return { header, body, createdAt: comment.createdAt };
}

function projectTicket(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    number: issue.number,
    title: issue.title,
    priority: issue.priority,
    parent: issue.parent ? issue.parent.id : null,
  };
}

// A ticket has a SETTLED Pre-Triage when deriving its comments yields anything other
// than `triage` (no artifact, or a fresh objective kick-back, both re-derive `triage`).
async function hasSettledPretriage(client, issueId) {
  const comments = await client.listComments(issueId);
  return derive(comments.map(projectArtifact)).stage !== 'triage';
}

export async function buildBoard({ client, projectId, statuses }) {
  const inProgressIssues = await client.listIssues(projectId, statuses['In Progress']);

  let inProgress = null;
  // WIP=1: at most one active ticket. If several appear (self-healing), the first
  // non-blocked one wins the slot; the rest are left for the next sweep.
  for (const issue of inProgressIssues) {
    const comments = await client.listComments(issue.id);
    const { stage } = derive(comments.map(projectArtifact));
    if (stage === 'blocked') continue;
    inProgress = { ticket: projectTicket(issue), stage };
    break;
  }

  const integrated = [];
  for (const name of ['To Review', 'Done']) {
    if (!statuses[name]) continue;
    const issues = await client.listIssues(projectId, statuses[name]);
    for (const issue of issues) {
      integrated.push({ id: issue.id, parent: issue.parent ? issue.parent.id : null, updatedAt: issue.updatedAt });
    }
  }

  const todoIssues = await client.listIssues(projectId, statuses['Todo']);
  let todos = todoIssues.map((issue) => ({
    ...projectTicket(issue),
    // blockedBy comes from issue relations; the live client can be extended to
    // hydrate it. Default to no blockers (eligible) when unavailable.
    blockedBy: issue.blockedBy ?? [],
  }));

  // Hydrate `hasPretriage` only for the ordered/capped eligible Todo candidates — the
  // ones decide() may pre-triage (or reconcile via move-to-triage) this sweep — so we
  // never list comments for every Todo on the board.
  const candidates = orderTodos(eligibleTodos(todos), integrated).slice(0, PRETRIAGE_CAP);
  const flags = new Map();
  for (const c of candidates) {
    flags.set(c.id, await hasSettledPretriage(client, c.id));
  }
  todos = todos.map((t) => (flags.has(t.id) ? { ...t, hasPretriage: flags.get(t.id) } : t));

  // Triage column = pure signal. Each ticket there carries whether its Pre-Triage is
  // settled: settled → a HOLD (human's turn); not settled (legacy empty Triage from the
  // old model) → decide() re-triages it in-place. The status may not exist yet (a human
  // creates the column) → triage stays an empty list.
  const triage = [];
  if (statuses['Triage']) {
    const triageIssues = await client.listIssues(projectId, statuses['Triage']);
    for (const issue of triageIssues) {
      triage.push({ ...projectTicket(issue), hasPretriage: await hasSettledPretriage(client, issue.id) });
    }
  }

  return { inProgress, todos, triage, integrated };
}
