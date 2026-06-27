'use strict';

const { openDb, EMBED_DIM } = require('./db');
const { migrate } = require('./migrate');
const { createProvider } = require('./embeddings');
const { chunkText } = require('./chunking');

// Do NOT import `registry` here — the memory layer is decoupled (WLN-12).

/**
 * Serializes a Float32Array into the format accepted by sqlite-vec on writes and
 * in the MATCH clause (Buffer of the underlying buffer).
 */
function toBlob(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

const FILTER_COLUMNS = ['ticket_id', 'stage', 'kind', 'source'];

/**
 * Memory layer: ingestion (chunk → embed → persist vector+metadata) and
 * hybrid query (metadata filter + similarity KNN).
 */
class Memory {
  /**
   * @param {import('better-sqlite3').Database} db already-migrated connection.
   * @param {object} opts
   * @param {object} [opts.provider] embedding provider (default: fake).
   */
  constructor(db, { provider } = {}) {
    this.db = db;
    this.provider = provider || createProvider('fake');
    if (this.provider.dim !== EMBED_DIM) {
      throw new Error(
        `Provider "${this.provider.name}" has dim=${this.provider.dim}, ` +
          `expected ${EMBED_DIM}. Changing dim requires a new migration + re-index.`
      );
    }
    this._insertChunk = db.prepare(
      `INSERT INTO chunks (ticket_id, stage, kind, source, chunk_index, body)
       VALUES (@ticket_id, @stage, @kind, @source, @chunk_index, @body)`
    );
    this._insertVec = db.prepare(
      'INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)'
    );
  }

  /**
   * Ingests a document: chunking + embedding + transactional persistence.
   * Metadata and vector share the same rowid.
   *
   * @param {object} doc
   * @param {string} doc.ticketId
   * @param {string} [doc.stage]
   * @param {string} [doc.kind]
   * @param {string} [doc.source]
   * @param {string} doc.text
   * @param {object} [doc.chunkOpts] chunking options (size/overlap).
   * @returns {Promise<{chunks:number, ids:number[]}>}
   */
  async ingest({ ticketId, stage = null, kind = null, source = null, text, chunkOpts }) {
    if (!ticketId) throw new Error('ingest: ticketId is required');
    const pieces = chunkText(text, chunkOpts);
    if (pieces.length === 0) return { chunks: 0, ids: [] };

    const vectors = await this.provider.embed(pieces);

    const run = this.db.transaction(() => {
      // Idempotency by `source`: re-ingesting the same artifact replaces the
      // previous chunks instead of duplicating. `source == null` does not trigger
      // dedup (otherwise it would delete every chunk with source IS NULL).
      if (source != null) this._purgeSource(source);
      const ids = [];
      for (let i = 0; i < pieces.length; i++) {
        const info = this._insertChunk.run({
          ticket_id: ticketId,
          stage,
          kind,
          source,
          chunk_index: i,
          body: pieces[i],
        });
        // sqlite-vec requires the rowid (vec0 PK) as an integer — we use the
        // original BigInt from lastInsertRowid to satisfy the bind.
        const rowid = info.lastInsertRowid;
        this._insertVec.run(BigInt(rowid), toBlob(vectors[i]));
        ids.push(Number(rowid));
      }
      return ids;
    });

    const ids = run();
    return { chunks: ids.length, ids };
  }

  /**
   * Ingests several documents in sequence. Each document is an independent
   * transaction (via `ingest`).
   *
   * @param {Array<object>} docs
   * @returns {Promise<{chunks:number, ids:number[]}>} aggregated totals.
   */
  async ingestBatch(docs) {
    let chunks = 0;
    const ids = [];
    for (const doc of docs) {
      const res = await this.ingest(doc);
      chunks += res.chunks;
      ids.push(...res.ids);
    }
    return { chunks, ids };
  }

  /**
   * Hybrid query: metadata filter + similarity KNN, ordered by `distance`
   * ascending (smaller = more similar).
   *
   * @param {string} text natural-language query.
   * @param {object} [opts]
   * @param {object} [opts.filter] subset of {ticket_id,stage,kind,source}.
   * @param {number} [opts.k=5] top-k.
   * @returns {Promise<Array<{ticket_id,stage,kind,source,body,chunk_index,distance}>>}
   */
  async query(text, { filter = {}, k = 5 } = {}) {
    const [qvec] = await this.provider.embed([text]);

    const where = ['c.ticket_id IS NOT NULL'];
    const params = [];
    for (const col of FILTER_COLUMNS) {
      if (filter[col] !== undefined && filter[col] !== null) {
        where.push(`c.${col} = ?`);
        params.push(filter[col]);
      }
    }

    // sqlite-vec KNN requires `embedding MATCH ? AND k = ?` in the vector
    // subquery; the JOIN brings the metadata and the WHERE applies the hybrid filter.
    const sql = `
      SELECT c.ticket_id, c.stage, c.kind, c.source, c.body, c.chunk_index, v.distance
      FROM (
        SELECT rowid, distance
        FROM vec_chunks
        WHERE embedding MATCH ? AND k = ?
      ) AS v
      JOIN chunks AS c ON c.id = v.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY v.distance ASC
      LIMIT ?
    `;

    // Asks the KNN for more candidates than `k` so the metadata filter can
    // still return `k` valid results. With a selective filter, `4*k` may empty
    // the result (all near neighbors fall outside the filter); in that case we
    // widen the KNN window (capped at totalRows / 200) so a real match does not
    // become `[]`. Without a filter, we keep `4*k` (same as the previous behavior).
    const hasFilter = FILTER_COLUMNS.some(
      (col) => filter[col] !== undefined && filter[col] !== null
    );
    const knnK = hasFilter
      ? Math.min(
          this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n,
          Math.max(k * 4, 200)
        )
      : Math.max(k * 4, k);
    const stmt = this.db.prepare(sql);
    return stmt.all(toBlob(qvec), knnK, ...params, k);
  }

  /**
   * Direct fetch by metadata, WITHOUT KNN/vector: brings the whole artifact (all
   * chunks matching the filter), ordered by `source, chunk_index` asc.
   * For "the ticket's own spec" (exact retrieval by metadata), where KNN +
   * post-selection filter could return `[]` even with a match. Does not embed
   * text nor touch `vec_chunks`.
   *
   * @param {object} [filter] subset of {ticket_id,stage,kind,source}.
   * @param {object} [opts]
   * @param {number} [opts.k] optional LIMIT; without it, brings all chunks.
   * @returns {Array<{ticket_id,stage,kind,source,body,chunk_index,distance}>}
   *   `distance` is always `null` (shape compatible with `query`).
   */
  fetch(filter = {}, { k } = {}) {
    const where = ['ticket_id IS NOT NULL'];
    const params = [];
    for (const col of FILTER_COLUMNS) {
      if (filter[col] !== undefined && filter[col] !== null) {
        where.push(`${col} = ?`);
        params.push(filter[col]);
      }
    }

    let sql = `
      SELECT ticket_id, stage, kind, source, body, chunk_index, NULL AS distance
      FROM chunks
      WHERE ${where.join(' AND ')}
      ORDER BY source, chunk_index ASC
    `;
    if (k !== undefined && k !== null) {
      sql += ' LIMIT ?';
      params.push(k);
    }
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Removes all chunks (metadata + vectors) of a given `source`.
   * Since `chunks.id` matches the `rowid` of `vec_chunks` (no FK/cascade between
   * the virtual and the relational table), we delete both paired in a transaction.
   *
   * @param {string} source
   * @returns {number} number of chunks removed.
   */
  deleteBySource(source) {
    const run = this.db.transaction(() => this._purgeSource(source));
    return run();
  }

  /**
   * Core of deletion by `source` WITHOUT its own `db.transaction`, so it can be
   * reused both by `deleteBySource` (which does the transactional wrap) and by
   * `ingest` (already running inside its transaction). Avoids a nested transaction
   * and preserves the `chunks`↔`vec_chunks` pairing (same id/rowid).
   *
   * @param {string} source
   * @returns {number} number of chunks removed.
   */
  _purgeSource(source) {
    const ids = this.db
      .prepare('SELECT id FROM chunks WHERE source = ?')
      .all(source)
      .map((r) => r.id);
    const delVec = this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
    // sqlite-vec requires the rowid as an integer in the bind — same pattern as ingest.
    for (const id of ids) delVec.run(BigInt(id));
    this.db.prepare('DELETE FROM chunks WHERE source = ?').run(source);
    return ids.length;
  }

  close() {
    this.db.close();
  }
}

/**
 * Creates a Memory over an existing connection, running migrations.
 */
function createMemory(db, opts = {}) {
  migrate(db);
  return new Memory(db, opts);
}

/**
 * Opens (or creates) a memory file, loads sqlite-vec, runs migrations and
 * returns the ready Memory.
 *
 * @param {string} [file=':memory:']
 * @param {object} [opts] { provider }
 */
function openMemory(file = ':memory:', opts = {}) {
  const db = openDb(file);
  return createMemory(db, opts);
}

module.exports = { Memory, createMemory, openMemory, EMBED_DIM };
