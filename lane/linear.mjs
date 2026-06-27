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

// The `stage` label group name (CLAUDE.md). Stage labels are its children and are
// named `stage:understand` / `stage:execution` / `stage:review` / `stage:blocked`.
export const STAGE_GROUP = 'stage';

export function createClient({
  apiKey = process.env.LINEAR_API_KEY,
  fetchImpl = globalThis.fetch,
  endpoint = ENDPOINT,
} = {}) {
  if (!apiKey) throw new Error('LINEAR_API_KEY is required');
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');

  async function gql(query, variables = {}) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) {
      throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data;
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
      const inGroup = (l.parent && l.parent.name === STAGE_GROUP) || l.name.startsWith(`${STAGE_GROUP}:`);
      if (inGroup) out[l.name] = l.id;
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
