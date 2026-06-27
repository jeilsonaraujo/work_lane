// Unit tests for board.mjs projection helpers, fully OFFLINE (pure functions, no client).
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectArtifact } from './board.mjs';
import { derive } from './derive.mjs';

// Regression for the infinite-loop bug: a worker may print a prose preamble BEFORE the
// artifact header (validate.mjs accepts it via `.includes()`), so projectArtifact must
// find the header anywhere — not just on the first non-empty line. Taking the first line
// instead made a preambled-but-valid Context Spec invisible to derive(), which then fell
// back to the Pre-Triage and re-ran `understand` forever.
test('projectArtifact finds the header after a prose preamble', () => {
  const comment = {
    body: 'I have everything I need. Producing the Context Spec.\n\n## 🧭 Context Spec\n\n**Blockers:**\n',
    createdAt: '2026-06-26T17:01:00.000Z',
  };
  assert.equal(projectArtifact(comment).header, '## 🧭 Context Spec');
});

test('a preambled Context Spec (no blockers) derives execution, not understand', () => {
  // The exact shape that looped WLN-57: a Pre-Triage followed by a preambled Context Spec.
  const artifacts = [
    { body: '## 🎯 Pre-Triage\n\nObjective: research.', createdAt: '2026-06-26T16:45:00.000Z' },
    { body: 'Conventions confirmed. Producing the Context Spec.\n\n## 🧭 Context Spec\n\n**Blockers:**\n', createdAt: '2026-06-26T16:51:00.000Z' },
  ].map(projectArtifact);
  assert.equal(derive(artifacts).stage, 'execution');
});

test('projectArtifact falls back to the first non-empty line when no header is present', () => {
  const comment = { body: '\n\njust some prose, no marker\n', createdAt: '2026-06-26T00:00:00.000Z' };
  assert.equal(projectArtifact(comment).header, 'just some prose, no marker');
});
