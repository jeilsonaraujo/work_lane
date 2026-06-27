'use strict';

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

/**
 * Fixed dimension of the embedding vectors.
 *
 * This constant is the shared source of truth between the virtual table
 * `vec_chunks` (see schema/001_init.sql) and ALL embedding providers
 * (fake and real). Changing the model/dim requires a new migration + re-index —
 * see kb/README.md.
 *
 * 384 = dimension of `paraphrase-multilingual-MiniLM-L12-v2` (transformers.js),
 * the default multilingual model (PT included) of the real provider. The fake
 * provider generates vectors with this same dimension so the tests exercise the
 * real vector store.
 */
const EMBED_DIM = 384;

/**
 * Opens a SQLite connection with the sqlite-vec extension loaded.
 *
 * Mirrors the style of the registry layer (WLN-11): foreign_keys ON always,
 * WAL only for file-backed databases (makes no sense for `:memory:`).
 *
 * @param {string} [file=':memory:'] path of the .db file or ':memory:'.
 * @returns {import('better-sqlite3').Database}
 */
function openDb(file = ':memory:') {
  const db = new Database(file);
  // Loads the vector extension. Throws if the native binary is not
  // available — the caller (migrate/openMemory) propagates the error.
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

module.exports = { openDb, EMBED_DIM };
