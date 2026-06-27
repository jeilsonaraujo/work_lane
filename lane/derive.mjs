// lane/derive.mjs — PURE stage derivation from a ticket's artifacts.
//
// Source of truth = artifacts (comments), never the `stage:*` label nor the column.
// This is the code port of the derivation rules + the canonical anchored regexes from
// `.claude/skills/lane/SKILL.md`. The execution/review part is FORWARD-ONLY (no
// kick-back of merged/in-flight work); the ONLY re-run lives at the ENTRY phase —
// an objective `## ⛔ Kick-back:` bounces a ticket back to pre-triage.
//
// This per-ticket fn decides ONLY from the artifacts; it does NOT know which column the
// ticket sits in. Pre-triage runs WHILE a ticket is still in `Todo` (no artifact → the
// triager runs); once the `## 🎯 Pre-Triage` is posted the ticket derives `understand`
// and is moved to `Triage` to await the human gate. The `Triage` column is a pure
// signal — the decision of what to RUN lives in decide.mjs/board.mjs, not here.
//
// Input: an array of artifacts projected as { header, body, createdAt }.
//   - `header`  the artifact's leading line (e.g. "## 🧭 Context Spec")
//   - `body`    the full artifact text (used only to match the structured field)
//   - createdAt an ISO timestamp (or anything `new Date()` parses)
// Output: { stage, reason? } with stage ∈
//   'triage' | 'understand' | 'execution' | 'review' | 'sign-off' | 'blocked'.

// Canonical, anchored, multiline field regexes — verbatim from the SKILL.
export const VERDICT_RE = /^\*\*Verdict:\*\*\s*(APPROVED|REJECTED)\b/m;
export const STATUS_RE = /^\*\*Status:\*\*\s*(SUCCESS|FAILED)\b/m;
export const BLOCKERS_RE = /^\*\*Blockers:\*\*/m;

// Canonical artifact headers (the station markers stay verbatim in English).
export const HEADERS = {
  pretriage: '## 🎯 Pre-Triage',
  spec: '## 🧭 Context Spec',
  worklog: '## 🔧 Work Log',
  review: '## 🔍 Review',
  kickback: '## ⛔ Kick-back',
};

// Attempts cap: the number of REJECTED reviews that pushes a ticket to `blocked`.
export const REJECTED_CAP = 3;

export function headerKind(header) {
  const h = (header ?? '').trim();
  if (h.startsWith(HEADERS.review)) return 'review';
  if (h.startsWith(HEADERS.worklog)) return 'worklog';
  if (h.startsWith(HEADERS.spec)) return 'spec';
  if (h.startsWith(HEADERS.pretriage)) return 'pretriage';
  if (h.startsWith(HEADERS.kickback)) return 'kickback';
  return null;
}

// A leading "no blockers" sentinel: the agent wrote a prose `None …` / `N/A` / `-`
// instead of leaving the field empty. Anchored at the start (after stripping leading
// bullet/markdown chars) so a REAL blocker that merely mentions the word later still
// counts. Covers en/pt phrasing.
const NO_BLOCKERS_RE = /^(none|nenhuma?|n\/?a|nada|no\s+blockers?)\b/;

// Non-empty Blockers = real text after the **Blockers:** marker. EMPTY, or a leading
// none-sentinel (`None…`, `N/A`, a lone dash), counts as NO blockers — otherwise a
// Context Spec that politely writes "Blockers: None that block implementation" would
// false-positive the ticket into `blocked`. Returns null when the marker is absent
// (→ malformed).
function blockersNonEmpty(body) {
  const m = BLOCKERS_RE.exec(body ?? '');
  if (!m) return null;
  const rest = (body ?? '').slice(m.index + m[0].length).trim();
  if (rest.length === 0) return false;
  if (/^[–—-]+$/.test(rest)) return false; // a lone dash means "none"
  const lead = rest.toLowerCase().replace(/^[\s:>*_-]+/, '');
  if (NO_BLOCKERS_RE.test(lead)) return false;
  return true;
}

export function derive(artifacts) {
  // Keep only recognised station artifacts; tag each with its kind.
  const list = [...(artifacts ?? [])]
    .map((a) => ({ ...a, kind: headerKind(a.header) }))
    .filter((a) => a.kind !== null);

  // Entry: no artifact at all → triage (pre-triage gate). "No label" never means
  // "new" — new = no artifact, and a brand-new ticket starts at pre-triage.
  if (list.length === 0) return { stage: 'triage' };

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

    if (art.kind === 'kickback') {
      // Entry-gate re-run: a human bounced the objective back to pre-triage. Newer
      // than the last Pre-Triage → re-run the triager (no enum field to parse).
      return { stage: 'triage', reason: 'objective kick-back' };
    }

    if (art.kind === 'pretriage') {
      // Pre-Triage posted and nothing newer decided → the objective is settled. The
      // ticket is moved to `Triage` and HOLDS at the human entry gate (Triage → In
      // Progress); only then does the `understand` station run.
      return { stage: 'understand' };
    }
  }

  // Unreachable (every kept artifact has a known kind), but keep the entry default.
  return { stage: 'triage' };
}
