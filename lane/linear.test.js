// Unit tests for the Linear GraphQL client, with a MOCKED fetch (NO live network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, STAGE_DONE } from './linear.mjs';

// Build a fake fetch that records calls and returns a canned GraphQL payload.
function makeFetch(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok, status, json: async () => payload };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('throws without an apiKey', () => {
  assert.throws(() => createClient({ apiKey: undefined, fetchImpl: makeFetch({}) }), /LINEAR_API_KEY/);
});

// Resilience: a transient `fetch failed` must be retried, not propagated (it used to
// strand a ticket in an /execute loop). sleep is stubbed so the test stays instant.
test('gql retries a transient fetch failure then succeeds', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n < 3) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => ({ data: { team: { states: { nodes: [] } } } }) };
  };
  const client = createClient({ apiKey: 'k', fetchImpl, sleep: async () => {} });
  await client.resolveStatuses('team-1'); // should not throw
  assert.equal(n, 3); // 2 failures + 1 success
});

test('gql gives up after exhausting retries (rethrows the last error)', async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; throw new TypeError('fetch failed'); };
  const client = createClient({ apiKey: 'k', fetchImpl, retries: 2, sleep: async () => {} });
  await assert.rejects(() => client.resolveStatuses('team-1'), /fetch failed/);
  assert.equal(n, 3); // 1 initial + 2 retries
});

test('gql retries a 503 then succeeds', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n < 2) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { team: { states: { nodes: [] } } } }) };
  };
  const client = createClient({ apiKey: 'k', fetchImpl, sleep: async () => {} });
  await client.resolveStatuses('team-1');
  assert.equal(n, 2);
});

test('sends the API key in the Authorization header (no Bearer prefix)', async () => {
  const fetchImpl = makeFetch({ data: { team: { states: { nodes: [] } } } });
  const client = createClient({ apiKey: 'lin_api_xyz', fetchImpl });
  await client.resolveStatuses('team-1');
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, 'lin_api_xyz');
  assert.equal(fetchImpl.calls[0].opts.headers['Content-Type'], 'application/json');
});

test('resolveStatuses maps name → id', async () => {
  const fetchImpl = makeFetch({
    data: { team: { states: { nodes: [
      { id: 's-todo', name: 'Todo' },
      { id: 's-prog', name: 'In Progress' },
    ] } } },
  });
  const client = createClient({ apiKey: 'k', fetchImpl });
  const statuses = await client.resolveStatuses('team-1');
  assert.deepEqual(statuses, { Todo: 's-todo', 'In Progress': 's-prog' });
  assert.equal(fetchImpl.calls[0].body.variables.teamId, 'team-1');
});

test('resolveLabels keeps only the stage group', async () => {
  const fetchImpl = makeFetch({
    data: { team: { labels: { nodes: [
      { id: 'l-u', name: 'stage:understand', parent: { id: 'g', name: 'stage' } },
      { id: 'l-x', name: 'area:backend', parent: { id: 'g2', name: 'area' } },
      { id: 'l-b', name: 'stage:blocked', parent: null },
    ] } } },
  });
  const client = createClient({ apiKey: 'k', fetchImpl });
  const labels = await client.resolveLabels('team-1');
  assert.deepEqual(labels, { 'stage:understand': 'l-u', 'stage:blocked': 'l-b' });
});

test('resolveLabels normalizes BARE grouped children to canonical stage:<x> keys', async () => {
  // The live board stores stage labels as bare children of the `stage` group (only
  // stage:done carries the prefix). resolveLabels must map them to `stage:<x>` so the
  // dispatcher's STATION labels (stage:understand, …) resolve — otherwise the stage
  // mirror is never applied.
  const fetchImpl = makeFetch({
    data: { team: { labels: { nodes: [
      { id: 'l-u', name: 'understand', parent: { id: 'g', name: 'stage' } },
      { id: 'l-e', name: 'execution', parent: { id: 'g', name: 'stage' } },
      { id: 'l-t', name: 'triage', parent: { id: 'g', name: 'stage' } },
      { id: 'l-done', name: 'stage:done', parent: { id: 'g', name: 'stage' } },
      { id: 'l-x', name: 'Bug', parent: null },
    ] } } },
  });
  const client = createClient({ apiKey: 'k', fetchImpl });
  const labels = await client.resolveLabels('team-1');
  assert.deepEqual(labels, {
    'stage:understand': 'l-u',
    'stage:execution': 'l-e',
    'stage:triage': 'l-t',
    'stage:done': 'l-done',
  });
});

test('resolveLabels resolves the green terminal stage:done by name (WLN-54)', async () => {
  const fetchImpl = makeFetch({
    data: { team: { labels: { nodes: [
      { id: 'l-r', name: 'stage:review', parent: { id: 'g', name: 'stage' } },
      // stage:done picked up by the `startsWith('stage:')` fallback even without a parent
      { id: 'l-done', name: 'stage:done', parent: null },
    ] } } },
  });
  const client = createClient({ apiKey: 'k', fetchImpl });
  const labels = await client.resolveLabels('team-1');
  assert.equal(labels[STAGE_DONE], 'l-done');
  assert.deepEqual(labels, { 'stage:review': 'l-r', 'stage:done': 'l-done' });
});

test('listIssues returns the nodes and passes project/state vars', async () => {
  const fetchImpl = makeFetch({
    data: { issues: { nodes: [{ id: 'i1', identifier: 'WLN-1', number: 1 }] } },
  });
  const client = createClient({ apiKey: 'k', fetchImpl });
  const issues = await client.listIssues('proj-1', 'state-1');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].identifier, 'WLN-1');
  assert.deepEqual(fetchImpl.calls[0].body.variables, { projectId: 'proj-1', stateId: 'state-1' });
});

test('listComments returns the comment nodes', async () => {
  const fetchImpl = makeFetch({
    data: { issue: { comments: { nodes: [{ id: 'c1', body: '## 🧭 Context Spec', createdAt: '2026-01-01T00:00:00Z' }] } } },
  });
  const client = createClient({ apiKey: 'k', fetchImpl });
  const comments = await client.listComments('i1');
  assert.equal(comments[0].id, 'c1');
});

test('createComment returns the created comment id', async () => {
  const fetchImpl = makeFetch({ data: { commentCreate: { success: true, comment: { id: 'c-new' } } } });
  const client = createClient({ apiKey: 'k', fetchImpl });
  const c = await client.createComment('i1', 'hello');
  assert.equal(c.id, 'c-new');
  assert.deepEqual(fetchImpl.calls[0].body.variables, { issueId: 'i1', body: 'hello' });
});

test('createComment throws when success=false', async () => {
  const fetchImpl = makeFetch({ data: { commentCreate: { success: false, comment: null } } });
  const client = createClient({ apiKey: 'k', fetchImpl });
  await assert.rejects(() => client.createComment('i1', 'x'), /commentCreate failed/);
});

test('updateIssue sends only the provided fields', async () => {
  const fetchImpl = makeFetch({ data: { issueUpdate: { success: true, issue: { id: 'i1', labels: { nodes: [{ id: 'l-x' }] } } } } });
  const client = createClient({ apiKey: 'k', fetchImpl });
  const issue = await client.updateIssue('i1', { stateId: 's-rev', labelIds: ['l-x'] });
  assert.equal(issue.id, 'i1');
  assert.deepEqual(fetchImpl.calls[0].body.variables.input, { stateId: 's-rev', labelIds: ['l-x'] });
});

test('updateIssue omits undefined fields from the input', async () => {
  const fetchImpl = makeFetch({ data: { issueUpdate: { success: true, issue: { id: 'i1', labels: { nodes: [] } } } } });
  const client = createClient({ apiKey: 'k', fetchImpl });
  await client.updateIssue('i1', { stateId: 's-rev' });
  assert.deepEqual(fetchImpl.calls[0].body.variables.input, { stateId: 's-rev' });
});

test('gql throws on HTTP error', async () => {
  const fetchImpl = makeFetch({}, { ok: false, status: 401 });
  const client = createClient({ apiKey: 'k', fetchImpl });
  await assert.rejects(() => client.resolveStatuses('team-1'), /HTTP 401/);
});

test('gql throws on GraphQL errors', async () => {
  const fetchImpl = makeFetch({ errors: [{ message: 'bad query' }] });
  const client = createClient({ apiKey: 'k', fetchImpl });
  await assert.rejects(() => client.resolveStatuses('team-1'), /bad query/);
});
