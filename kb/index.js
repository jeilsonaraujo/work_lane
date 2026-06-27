'use strict';

const { openDb, EMBED_DIM } = require('./db');
const { migrate } = require('./migrate');
const { createProvider } = require('./embeddings');
const { chunkText } = require('./chunking');

// NÃO importar `registry` aqui — a camada de memória é desacoplada (DIM-12).

/**
 * Serializa um Float32Array para o formato aceito pelo sqlite-vec na escrita e
 * na cláusula MATCH (Buffer do buffer subjacente).
 */
function toBlob(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

const FILTER_COLUMNS = ['ticket_id', 'stage', 'kind', 'source'];

/**
 * Camada de memória: ingestão (chunk → embed → persiste vetor+metadados) e
 * query híbrida (filtro de metadados + KNN por similaridade).
 */
class Memory {
  /**
   * @param {import('better-sqlite3').Database} db conexão já migrada.
   * @param {object} opts
   * @param {object} [opts.provider] provider de embedding (default: fake).
   */
  constructor(db, { provider } = {}) {
    this.db = db;
    this.provider = provider || createProvider('fake');
    if (this.provider.dim !== EMBED_DIM) {
      throw new Error(
        `Provider "${this.provider.name}" tem dim=${this.provider.dim}, ` +
          `esperado ${EMBED_DIM}. Trocar dim exige nova migration + re-index.`
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
   * Ingesta um documento: chunking + embedding + persistência transacional.
   * Metadados e vetor compartilham o mesmo rowid.
   *
   * @param {object} doc
   * @param {string} doc.ticketId
   * @param {string} [doc.stage]
   * @param {string} [doc.kind]
   * @param {string} [doc.source]
   * @param {string} doc.text
   * @param {object} [doc.chunkOpts] opções de chunking (size/overlap).
   * @returns {Promise<{chunks:number, ids:number[]}>}
   */
  async ingest({ ticketId, stage = null, kind = null, source = null, text, chunkOpts }) {
    if (!ticketId) throw new Error('ingest: ticketId é obrigatório');
    const pieces = chunkText(text, chunkOpts);
    if (pieces.length === 0) return { chunks: 0, ids: [] };

    const vectors = await this.provider.embed(pieces);

    const run = this.db.transaction(() => {
      // Idempotência por `source`: reingerir o mesmo artefato substitui os
      // chunks anteriores em vez de duplicar. `source == null` não dispara
      // dedup (senão apagaria todos os chunks com source IS NULL).
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
        // sqlite-vec exige a rowid (PK da vec0) como inteiro — usamos o
        // BigInt original de lastInsertRowid para satisfazer o bind.
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
   * Ingesta vários documentos em sequência. Cada documento é uma transação
   * independente (via `ingest`).
   *
   * @param {Array<object>} docs
   * @returns {Promise<{chunks:number, ids:number[]}>} totais agregados.
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
   * Query híbrida: filtro por metadados + KNN por similaridade, ordenado por
   * `distance` ascendente (menor = mais similar).
   *
   * @param {string} text consulta em linguagem natural.
   * @param {object} [opts]
   * @param {object} [opts.filter] subconjunto de {ticket_id,stage,kind,source}.
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

    // KNN do sqlite-vec exige `embedding MATCH ? AND k = ?` na subconsulta
    // vetorial; o JOIN traz os metadados e o WHERE aplica o filtro híbrido.
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

    // Pede mais candidatos ao KNN do que `k` para que o filtro de metadados
    // ainda possa devolver `k` resultados válidos.
    const knnK = Math.max(k * 4, k);
    const stmt = this.db.prepare(sql);
    return stmt.all(toBlob(qvec), knnK, ...params, k);
  }

  /**
   * Remove todos os chunks (metadados + vetores) de uma dada `source`.
   * Como `chunks.id` casa com o `rowid` de `vec_chunks` (sem FK/cascade entre
   * a tabela virtual e a relacional), apagamos os dois pareados numa transação.
   *
   * @param {string} source
   * @returns {number} quantidade de chunks removidos.
   */
  deleteBySource(source) {
    const run = this.db.transaction(() => this._purgeSource(source));
    return run();
  }

  /**
   * Núcleo de deleção por `source` SEM `db.transaction` própria, para ser
   * reusado tanto por `deleteBySource` (que faz o wrap transacional) quanto por
   * `ingest` (já rodando dentro da sua transação). Evita transação aninhada e
   * preserva o pareamento `chunks`↔`vec_chunks` (mesmo id/rowid).
   *
   * @param {string} source
   * @returns {number} quantidade de chunks removidos.
   */
  _purgeSource(source) {
    const ids = this.db
      .prepare('SELECT id FROM chunks WHERE source = ?')
      .all(source)
      .map((r) => r.id);
    const delVec = this.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
    // sqlite-vec exige a rowid como inteiro no bind — mesmo padrão do ingest.
    for (const id of ids) delVec.run(BigInt(id));
    this.db.prepare('DELETE FROM chunks WHERE source = ?').run(source);
    return ids.length;
  }

  close() {
    this.db.close();
  }
}

/**
 * Cria uma Memory sobre uma conexão existente, rodando migrations.
 */
function createMemory(db, opts = {}) {
  migrate(db);
  return new Memory(db, opts);
}

/**
 * Abre (ou cria) um arquivo de memória, carrega sqlite-vec, roda migrations e
 * devolve a Memory pronta.
 *
 * @param {string} [file=':memory:']
 * @param {object} [opts] { provider }
 */
function openMemory(file = ':memory:', opts = {}) {
  const db = openDb(file);
  return createMemory(db, opts);
}

module.exports = { Memory, createMemory, openMemory, EMBED_DIM };
