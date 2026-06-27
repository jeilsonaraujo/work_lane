'use strict';

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

/**
 * Dimensão fixa dos vetores de embedding.
 *
 * Esta constante é a fonte de verdade compartilhada entre a tabela virtual
 * `vec_chunks` (ver schema/001_init.sql) e TODOS os providers de embedding
 * (fake e real). Trocar o modelo/dim exige uma nova migration + re-index —
 * ver memory/README.md.
 *
 * 384 = dimensão de `bge-small` (transformers.js). O provider fake gera vetores
 * com esta mesma dimensão para que os testes exercitem o store vetorial real.
 */
const EMBED_DIM = 384;

/**
 * Abre uma conexão SQLite com a extensão sqlite-vec carregada.
 *
 * Espelha o estilo da camada de registro (DIM-11): foreign_keys ON sempre,
 * WAL apenas para bancos em arquivo (não faz sentido em `:memory:`).
 *
 * @param {string} [file=':memory:'] caminho do arquivo .db ou ':memory:'.
 * @returns {import('better-sqlite3').Database}
 */
function openDb(file = ':memory:') {
  const db = new Database(file);
  // Carrega a extensão vetorial. Lança se o binário nativo não estiver
  // disponível — o chamador (migrate/openMemory) propaga o erro.
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

module.exports = { openDb, EMBED_DIM };
