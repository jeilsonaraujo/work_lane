// lane/post.mjs — post a station artifact: validate → createComment → ingest → set
// status/label. Thin glue over the pure validator + the Linear client + kb/ingest.
//
// The validation gate (d.0.6) is enforced here: an artifact outside the template is
// NOT posted and NOT ingested, so derivation never sees a malformed field.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validate } from './validate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INGEST = path.resolve(__dirname, '..', 'kb', 'ingest.mjs');

// stage(station) → kind, mirroring SKILL d.1.3.
const KIND = { understand: 'spec', execution: 'worklog', review: 'review' };

// Best-effort KB ingest (never throws into the caller). Mirrors SKILL d.1.
export function defaultIngest({ body, ticketId, station, source, fake = Boolean(process.env.KB_FAKE_EMBEDDINGS) }) {
  const args = [INGEST, '--ticket', ticketId, '--stage', station, '--kind', KIND[station] ?? 'doc'];
  if (source) args.push('--source', source);
  if (fake) args.push('--fake');
  const res = spawnSync(process.execPath, args, { input: body, encoding: 'utf8' });
  return { ok: res.status === 0, stdout: res.stdout, stderr: res.stderr };
}

export async function post({
  client,
  station,
  body,
  issueId,
  ticketId,
  stateId,
  labelId,
  ingest = defaultIngest,
}) {
  const v = validate(station, body);
  if (!v.ok) return { ok: false, error: v.error };

  const comment = await client.createComment(issueId, body);
  const commentId = comment && comment.id;

  // Best-effort ingest (never blocks/regresses the ticket).
  let ingested = { ok: false };
  try {
    ingested = ingest({ body, ticketId, station, source: commentId });
  } catch (e) {
    ingested = { ok: false, error: e && e.message ? e.message : String(e) };
  }

  // Reconcile status/label.
  const update = {};
  if (stateId !== undefined) update.stateId = stateId;
  if (labelId !== undefined) update.labelIds = [labelId];
  if (Object.keys(update).length > 0) await client.updateIssue(issueId, update);

  return { ok: true, commentId, ingested };
}
