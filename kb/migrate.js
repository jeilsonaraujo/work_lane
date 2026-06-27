'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EMBED_DIM } = require('./db');

const SCHEMA_DIR = path.join(__dirname, 'schema');

/**
 * Ensures the migrations control table.
 * Kept outside the .sql files so the runner is self-sufficient.
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
 * Reads the `NNN_*.sql` files from SCHEMA_DIR in lexicographic order.
 * The `version` is the file name without extension.
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
 * Applies all pending migrations. Idempotent: a 2nd call does not
 * reapply anything (queries `schema_migrations`). Each migration runs inside a
 * transaction together with recording the version.
 *
 * The {{EMBED_DIM}} placeholder is replaced by the constant from db.js, ensuring
 * the vector table and the providers agree on the dimension.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]} versions applied in this call.
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
