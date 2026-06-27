// lane/derive.mjs — PURE stage derivation from a ticket's artifacts.
//
// Source of truth = artifacts (comments), never the `stage:*` label. This is the
// code port of derivation rules 1–6 + the three canonical anchored regexes from
// `.claude/skills/lane/SKILL.md`. It is FORWARD-ONLY: there is no rule 0 /
// kick-back here (that stays in the prose driver / human gate).
//
// Input: an array of artifacts projected as { header, body, createdAt }.
//   - `header`  the artifact's leading line (e.g. "## 🧭 Context Spec")
//   - `body`    the full artifact text (used only to match the structured field)
//   - createdAt an ISO timestamp (or anything `new Date()` parses)
// Output: { stage, reason? } with stage ∈
//   'understand' | 'execution' | 'review' | 'sign-off' | 'blocked'.

// Canonical, anchored, multiline field regexes — verbatim from the SKILL.
export const VERDICT_RE = /^\*\*Verdict:\*\*\s*(APPROVED|REJECTED)\b/m;
export const STATUS_RE = /^\*\*Status:\*\*\s*(SUCCESS|FAILED)\b/m;
export const BLOCKERS_RE = /^\*\*Blockers:\*\*/m;

// Canonical artifact headers (the station markers stay verbatim in English).
export const HEADERS = {
  spec: '## 🧭 Context Spec',
  worklog: '## 🔧 Work Log',
  review: '## 🔍 Review',
};

// Attempts cap: the number of REJECTED reviews that pushes a ticket to `blocked`.
export const REJECTED_CAP = 3;

function headerKind(header) {
  const h = (header ?? '').trim();
  if (h.startsWith(HEADERS.review)) return 'review';
  if (h.startsWith(HEADERS.worklog)) return 'worklog';
  if (h.startsWith(HEADERS.spec)) return 'spec';
  return null;
}

// Non-empty Blockers = any text after the **Blockers:** marker (same line or the
// lines that follow). Returns null when the marker is absent (→ malformed).
function blockersNonEmpty(body) {
  const m = BLOCKERS_RE.exec(body ?? '');
  if (!m) return null;
  const rest = (body ?? '').slice(m.index + m[0].length).trim();
  return rest.length > 0;
}

export function derive(artifacts) {
  // Keep only recognised station artifacts; tag each with its kind.
  const list = [...(artifacts ?? [])]
    .map((a) => ({ ...a, kind: headerKind(a.header) }))
    .filter((a) => a.kind !== null);

  // Rule 6: no artifact at all → understand (entry). "No label" never means "new".
  if (list.length === 0) return { stage: 'understand' };

  // newest → oldest (the most recent deciding artifact wins; older can't override).
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Attempts = number of REJECTED reviews (by the anchored field, never a substring).
  const rejectedRe = /^\*\*Verdict:\*\*\s*REJECTED\b/m;
  const rejectedCount = list.filter(
    (a) => a.kind === 'review' && rejectedRe.test(a.body ?? '')
  ).length;

  // Recency short-circuit: stop at the first artifact that decides a rule.
  for (const art of list) {
    if (art.kind === 'review') {
      const m = VERDICT_RE.exec(art.body ?? '');
      // Header present but field unmatchable → malformed → blocked.
      if (!m) {
        return { stage: 'blocked', reason: 'field Verdict not matchable in the review artifact' };
      }
      // Rule 1.
      if (m[1] === 'APPROVED') return { stage: 'sign-off' };
      // Rule 2.
      return rejectedCount >= REJECTED_CAP
        ? { stage: 'blocked', reason: `review REJECTED ${rejectedCount}× (cap ${REJECTED_CAP})` }
        : { stage: 'execution' };
    }

    if (art.kind === 'worklog') {
      const m = STATUS_RE.exec(art.body ?? '');
      // Header present but field unmatchable → malformed → blocked.
      if (!m) {
        return { stage: 'blocked', reason: 'field Status not matchable in the execution artifact' };
      }
      // Rule 3 / Rule 4.
      return m[1] === 'SUCCESS'
        ? { stage: 'review' }
        : { stage: 'blocked', reason: 'work log Status = FAILED' };
    }

    if (art.kind === 'spec') {
      const nonEmpty = blockersNonEmpty(art.body);
      // Header present but Blockers line absent → malformed → blocked.
      if (nonEmpty === null) {
        return { stage: 'blocked', reason: 'field Blockers not matchable in the understand artifact' };
      }
      // Rule 5.
      return nonEmpty
        ? { stage: 'blocked', reason: 'context spec reports blockers' }
        : { stage: 'execution' };
    }
  }

  // Unreachable (every kept artifact has a known kind), but keep the entry default.
  return { stage: 'understand' };
}
