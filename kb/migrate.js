'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EMBED_DIM } = require('./db');

const SCHEMA_DIR = path.join(__dirname, 'schema');

/**
 * Garante a tabela de controle de migrations.
 * Mantida fora dos arquivos .sql para que o runner seja auto-suficiente.
 */
function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Lê os arquivos `NNN_*.sql` de SCHEMA_DIR em ordem lexicográfica.
 * A `version` é o nome do arquivo sem extensão.
 */
function listMigrations() {
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({
      version: path.basename(file, '.sql'),
      file: path.join(SCHEMA_DIR, file),
    }));
}

/**
 * Aplica todas as migrations pendentes. Idempotente: uma 2ª chamada não
 * reaplica nada (consulta `schema_migrations`). Cada migration roda dentro de
 * uma transação junto com o registro da versão.
 *
 * O placeholder {{EMBED_DIM}} é substituído pela constante de db.js, garantindo
 * que a tabela vetorial e os providers concordem sobre a dimensão.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]} versões aplicadas nesta chamada.
 */
function migrate(db) {
  ensureMigrationsTable(db);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const pending = listMigrations().filter((m) => !applied.has(m.version));
  const done = [];

  for (const m of pending) {
    const sql = fs
      .readFileSync(m.file, 'utf8')
      .replaceAll('{{EMBED_DIM}}', String(EMBED_DIM));

    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
    });
    run();
    done.push(m.version);
  }

  return done;
}

module.exports = { migrate, SCHEMA_DIR, listMigrations };
