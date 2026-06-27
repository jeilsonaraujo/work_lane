// lane/board.mjs — `lane-sync`: build the board projection consumed by decide().
//
// Thin glue: it asks the Linear client for the live state and reduces it to the
// shape decide.mjs expects. ALL logic stays in the pure modules (derive/decide).
//
// Returns: { inProgress: {ticket, stage}|null, todos:[...], integrated:[...] }

import { derive } from './derive.mjs';

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

  const todoIssues = await client.listIssues(projectId, statuses['Todo']);
  const todos = todoIssues.map((issue) => ({
    ...projectTicket(issue),
    // blockedBy comes from issue relations; the live client can be extended to
    // hydrate it. Default to no blockers (eligible) when unavailable.
    blockedBy: issue.blockedBy ?? [],
  }));

  const integrated = [];
  for (const name of ['To Review', 'Done']) {
    if (!statuses[name]) continue;
    const issues = await client.listIssues(projectId, statuses[name]);
    for (const issue of issues) {
      integrated.push({ id: issue.id, parent: issue.parent ? issue.parent.id : null, updatedAt: issue.updatedAt });
    }
  }

  return { inProgress, todos, integrated };
}
