// lane/decide.mjs — PURE next-action decision for one sweep.
//
// Encodes WIP=1 (the active In-Progress slot) + the pre-triage phase + the
// auto-sequence (pull) ordering from the SKILL. Given a board projection, returns
// a COMPOSITE plan:
//   {
//     active:    { type: 'understand'|'execution'|'review'|'merge'|'idle', ticket? },
//     pretriage: [ { type:'pretriage', ticket, from:'Todo'|'Triage' } ],  // ≤ PRETRIAGE_CAP
//     reconcile: [ { type:'move-to-triage', ticket } ],                   // pending moves
//   }
//
// Board projection shape:
//   {
//     inProgress: { ticket, stage } | null,   // the active In-Progress ticket + its DERIVED stage
//     todos:      [ { id, identifier, number, priority, parent, blockedBy:[{state}], hasPretriage? } ],
//     triage:     [ { id, identifier, number, priority, parent, hasPretriage } ],  // tickets in the Triage column
//     integrated: [ { id, parent, updatedAt } ]  // tickets in To Review / Done
//   }
//
// Two INDEPENDENT phases:
//   - WIP=1 (active slot): at most ONE In-Progress ticket whose derived stage is
//     understand/execution/review (or sign-off, which still needs the merge) occupies
//     the active slot. A `blocked` ticket waits for a human and does NOT occupy it.
//   - PRE-TRIAGE phase (NOT gated by WIP=1, NOT blocked by the Triage column): the
//     triager runs on eligible `Todo`s WHILE they are still in `Todo`; only after the
//     `## 🎯 Pre-Triage` is posted does the ticket move `Todo → Triage`. The `Triage`
//     column itself is a PURE SIGNAL (a human's turn) — the lane runs NOTHING on a
//     ticket already holding there with its Pre-Triage. Up to PRETRIAGE_CAP pre-triages
//     run per sweep regardless of how many tickets sit in `Triage`.

// Max concurrent pre-triages per sweep, derived purely from board state (stateless:
// NO time-window / NO persisted timestamp). A sweep can hold 1 active ticket AND
// pre-triage up to this many candidates.
export const PRETRIAGE_CAP = 3;

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

// The WIP=1 active In-Progress action. `blocked` (or no ticket) frees the slot → idle.
function decideActive(ip) {
  if (ip && ip.stage) {
    const s = ip.stage;
    if (s === 'understand' || s === 'execution' || s === 'review') {
      return { type: s, ticket: ip.ticket };
    }
    if (s === 'sign-off') {
      return { type: 'merge', ticket: ip.ticket };
    }
    // `blocked` → the active slot is free; nothing to run on it this sweep.
  }
  return { type: 'idle' };
}

export function decide(board) {
  // 1. The WIP=1 active slot (strict: at most one In-Progress action).
  const active = decideActive(board?.inProgress);

  const integrated = board?.integrated ?? [];

  // 2. Reconcile: eligible `Todo`s that ALREADY carry a `## 🎯 Pre-Triage` (the triager
  //    ran while they were in `Todo`) but have not been moved yet → emit a pending
  //    `move-to-triage` (NOT a re-triage — idempotency by artifact). Not capped.
  const eligible = eligibleTodos(board?.todos ?? []);
  const reconcile = eligible
    .filter((t) => t.hasPretriage === true)
    .map((ticket) => ({ type: 'move-to-triage', ticket }));

  // 3. Pre-triage candidates WITHOUT a Pre-Triage artifact: eligible `Todo`s
  //    (from:'Todo') and LEGACY empty `Triage` tickets (from:'Triage', triaged
  //    in-place). Ordered together by orderTodos, capped at PRETRIAGE_CAP.
  const todoCandidates = eligible.filter((t) => t.hasPretriage !== true);
  const legacyTriage = (board?.triage ?? []).filter((t) => t.hasPretriage !== true);
  const legacyIds = new Set(legacyTriage.map((t) => t.id));
  const ordered = orderTodos([...todoCandidates, ...legacyTriage], integrated);
  const pretriage = ordered.slice(0, PRETRIAGE_CAP).map((ticket) => ({
    type: 'pretriage',
    ticket,
    from: legacyIds.has(ticket.id) ? 'Triage' : 'Todo',
  }));

  // NOTE: tickets in `Triage` WITH a Pre-Triage artifact (hasPretriage === true) are a
  // pure HOLD — the human's turn (Triage → In Progress). The lane runs nothing on them.

  return { active, pretriage, reconcile };
}
