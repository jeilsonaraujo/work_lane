// lane/decide.mjs — PURE next-action decision for one sweep.
//
// Encodes WIP=1 + the auto-sequence (pull) ordering from the SKILL. Given a board
// projection, returns the single next action:
//   { type: 'understand'|'execution'|'review'|'merge'|'pull'|'idle', ticket? }
//
// Board projection shape:
//   {
//     inProgress: { ticket, stage } | null,   // the active In-Progress ticket + its DERIVED stage
//     todos:      [ { id, identifier, number, priority, parent, blockedBy:[{state}] } ],
//     integrated: [ { id, parent, updatedAt } ]  // tickets in To Review / Done
//   }
//
// WIP=1: an In-Progress ticket whose derived stage is understand/execution/review
// (or sign-off, which still needs the merge) occupies the slot. A `blocked` ticket
// waits for a human and does NOT occupy the slot — so the lane may pull behind it.

// Linear numeric priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low.
// Lower rank = pulled first (Urgent > High > Medium > Low > None).
function priorityRank(p) {
  const order = { 1: 0, 2: 1, 3: 2, 4: 3, 0: 4 };
  return order[p] ?? 4;
}

// Eligible Todo = ALL its blockedBy already integrated (To Review or Done).
function isEligible(todo) {
  const deps = todo.blockedBy ?? [];
  return deps.every((d) => d.state === 'To Review' || d.state === 'Done');
}

export function eligibleTodos(todos) {
  return (todos ?? []).filter(isEligible);
}

// Epic-continuity anchor = parent of the most-recently-integrated ticket
// (max updatedAt among To Review/Done). Reconstructed from the board every sweep.
export function anchorParent(integrated) {
  const list = integrated ?? [];
  if (list.length === 0) return null;
  let best = list[0];
  for (const t of list) {
    if (new Date(t.updatedAt) > new Date(best.updatedAt)) best = t;
  }
  return best.parent ?? null;
}

export function orderTodos(eligible, integrated) {
  const anchor = anchorParent(integrated);
  return [...eligible].sort((a, b) => {
    // 1. epic continuity: same parent as the anchor first.
    const aAnchor = anchor != null && a.parent === anchor ? 0 : 1;
    const bAnchor = anchor != null && b.parent === anchor ? 0 : 1;
    if (aAnchor !== bAnchor) return aAnchor - bAnchor;
    // 2. priority.
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    // 3. lowest ticket number (tie-break).
    return a.number - b.number;
  });
}

export function decide(board) {
  const ip = board?.inProgress;
  if (ip && ip.stage) {
    const s = ip.stage;
    if (s === 'understand' || s === 'execution' || s === 'review') {
      return { type: s, ticket: ip.ticket };
    }
    if (s === 'sign-off') {
      return { type: 'merge', ticket: ip.ticket };
    }
    // `blocked` → slot is free; fall through to the pull logic.
  }

  // No active ticket: auto-sequence pull (WIP=1, self-starting — no human entry gate).
  const eligible = eligibleTodos(board?.todos ?? []);
  if (eligible.length === 0) return { type: 'idle' };
  const sorted = orderTodos(eligible, board?.integrated ?? []);
  return { type: 'pull', ticket: sorted[0] };
}
