// lane/linear.mjs — minimal Linear GraphQL client over https://api.linear.app/graphql.
//
// Uses global `fetch` (Node 18+); the fetch impl is INJECTABLE so tests mock it
// (NO live network in tests). Auth is the raw API key in the `Authorization`
// header (Linear personal API keys are sent without a `Bearer ` prefix), read
// from `LINEAR_API_KEY` by default.
//
// Ops: resolveStatuses / resolveLabels (by name), listIssues, listComments,
// createComment, updateIssue. Each returns plain projected data.

export const ENDPOINT = 'https://api.linear.app/graphql';

// The `stage` label group name (CLAUDE.md). On the live board the stage labels are
// stored as BARE grouped children (`understand` / `execution` / `review` / `triage` /
// `blocked`, each with parent group `stage`) — only `stage:done` carries the literal
// prefix. resolveLabels NORMALIZES both forms to the canonical `stage:<x>` keys the rest
// of the code/CLAUDE.md contract expects, so consumers always use `stage:understand` etc.
export const STAGE_GROUP = 'stage';

// The green terminal label set when an APPROVED ticket is integrated and moved to
// `To Review` (SKILL c2/e). It is NOT a derived stage (no `done` in derive.mjs) — purely a
// terminal mirror. `resolveLabels` already picks it up via the `startsWith('stage:')` filter,
// so no functional change is needed here; this constant just documents the parity.
export const STAGE_DONE = 'stage:done';

export function createClient({
  apiKey = process.env.LINEAR_API_KEY,
  fetchImpl = globalThis.fetch,
  endpoint = ENDPOINT,
  // Resilience: a transient `fetch failed` (DNS/connection blip) or a 429/5xx must NOT
  // discard a station artifact — that used to strand a ticket in an `/execute` loop, the
  // executor re-implementing every tick until a post happened to succeed. Retry with
  // exponential backoff; 0 retries (`retries:0`) restores the old fail-fast behavior.
  retries = 3,
  backoffMs = 250,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!apiKey) throw new Error('LINEAR_API_KEY is required');
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');

  // A response is worth retrying on a 429 (rate limit) or any 5xx (server-side).
  const retriable = (status) => status === 429 || (status >= 500 && status <= 599);

  async function gql(query, variables = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: apiKey,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        // Network-level failure (e.g. "fetch failed") — retry until exhausted.
        lastErr = e;
        continue;
      }
      if (!res.ok) {
        if (retriable(res.status) && attempt < retries) {
          lastErr = new Error(`Linear HTTP ${res.status}`);
          continue;
        }
        throw new Error(`Linear HTTP ${res.status}`);
      }
      const json = await res.json();
      if (json.errors) {
        throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
      }
      return json.data;
    }
    throw lastErr;
  }

  // team.states → { name: id }
  async function resolveStatuses(teamId) {
    const data = await gql(
      `query($teamId:String!){ team(id:$teamId){ states{ nodes{ id name } } } }`,
      { teamId }
    );
    const out = {};
    for (const s of data.team.states.nodes) out[s.name] = s.id;
    return out;
  }

  // team.labels filtered to the `stage` group → { name: id }
  async function resolveLabels(teamId) {
    const data = await gql(
      `query($teamId:String!){ team(id:$teamId){ labels{ nodes{ id name parent{ id name } } } } }`,
      { teamId }
    );
    const out = {};
    for (const l of data.team.labels.nodes) {
      const grouped = Boolean(l.parent && l.parent.name === STAGE_GROUP);
      const prefixed = l.name.startsWith(`${STAGE_GROUP}:`);
      if (!grouped && !prefixed) continue;
      // Normalize to the canonical `stage:<x>` key whether the Linear label is a bare
      // grouped child (`understand`, parent "stage") or already prefixed (`stage:done`).
      // Without this a bare child resolves under the wrong key and the stage:* mirror is
      // never applied (the ticket sits with no stage label).
      const key = prefixed ? l.name : `${STAGE_GROUP}:${l.name}`;
      out[key] = l.id;
    }
    return out;
  }

  // Issues of a project in a given workflow state.
  async function listIssues(projectId, stateId) {
    const data = await gql(
      `query($projectId:ID,$stateId:ID){
         issues(filter:{ project:{ id:{ eq:$projectId } }, state:{ id:{ eq:$stateId } } }){
           nodes{ id identifier number title priority updatedAt
                  parent{ id }
                  state{ id name }
                  labels{ nodes{ id name } } }
         }
       }`,
      { projectId, stateId }
    );
    return data.issues.nodes;
  }

  // Comments of one issue (id, body, createdAt) — ascending by createdAt.
  async function listComments(issueId) {
    const data = await gql(
      `query($issueId:String!){ issue(id:$issueId){ comments{ nodes{ id body createdAt } } } }`,
      { issueId }
    );
    return data.issue.comments.nodes;
  }

  async function createComment(issueId, body) {
    const data = await gql(
      `mutation($issueId:String!,$body:String!){
         commentCreate(input:{ issueId:$issueId, body:$body }){ success comment{ id } }
       }`,
      { issueId, body }
    );
    if (!data.commentCreate.success) throw new Error('commentCreate failed');
    return data.commentCreate.comment;
  }

  async function updateIssue(id, { stateId, labelIds } = {}) {
    const input = {};
    if (stateId !== undefined) input.stateId = stateId;
    if (labelIds !== undefined) input.labelIds = labelIds;
    const data = await gql(
      `mutation($id:String!,$input:IssueUpdateInput!){
         issueUpdate(id:$id, input:$input){ success issue{ id labels{ nodes{ id } } } }
       }`,
      { id, input }
    );
    if (!data.issueUpdate.success) throw new Error('issueUpdate failed');
    return data.issueUpdate.issue;
  }

  return { gql, resolveStatuses, resolveLabels, listIssues, listComments, createComment, updateIssue };
}
