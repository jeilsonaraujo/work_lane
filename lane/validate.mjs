// lane/validate.mjs — PURE pre-post format validation (SKILL step d.0.6).
//
// One validator per station. An artifact that fails validation is never posted
// nor ingested, so derivation (derive.mjs) never sees a malformed field. Returns
// { ok, error? }. Checks mirror the SKILL exactly:
//   - understand: header `## 🧭 Context Spec` + a `**Blockers:**` line.
//   - execution:  header `## 🔧 Work Log`     + exactly one `**Status:** (SUCCESS|FAILED)`.
//   - review:     header `## 🔍 Review`        + exactly one `**Verdict:** (APPROVED|REJECTED)`.

import { VERDICT_RE, STATUS_RE, BLOCKERS_RE, HEADERS } from './derive.mjs';

function countMatches(re, text) {
  const g = new RegExp(re.source, 'gm');
  const m = (text ?? '').match(g);
  return m ? m.length : 0;
}

export function validateUnderstand(body) {
  if (!(body ?? '').includes(HEADERS.spec)) {
    return { ok: false, error: 'missing header ## 🧭 Context Spec' };
  }
  if (!BLOCKERS_RE.test(body ?? '')) {
    return { ok: false, error: 'missing **Blockers:** line' };
  }
  return { ok: true };
}

export function validateExecution(body) {
  if (!(body ?? '').includes(HEADERS.worklog)) {
    return { ok: false, error: 'missing header ## 🔧 Work Log' };
  }
  const n = countMatches(STATUS_RE, body);
  if (n === 0) return { ok: false, error: 'missing **Status:** SUCCESS|FAILED line' };
  if (n > 1) return { ok: false, error: 'more than one **Status:** line' };
  return { ok: true };
}

export function validateReview(body) {
  if (!(body ?? '').includes(HEADERS.review)) {
    return { ok: false, error: 'missing header ## 🔍 Review' };
  }
  const n = countMatches(VERDICT_RE, body);
  if (n === 0) return { ok: false, error: 'missing **Verdict:** APPROVED|REJECTED line' };
  if (n > 1) return { ok: false, error: 'more than one **Verdict:** line' };
  return { ok: true };
}

export function validate(station, body) {
  switch (station) {
    case 'understand':
      return validateUnderstand(body);
    case 'execution':
      return validateExecution(body);
    case 'review':
      return validateReview(body);
    default:
      return { ok: false, error: `unknown station: ${station}` };
  }
}
