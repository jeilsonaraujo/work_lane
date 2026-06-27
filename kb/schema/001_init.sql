-- Memory layer (WLN-12) — initial schema.
-- The vector dimension (EMBED_DIM) is injected by the runner (migrate.js)
-- replacing the placeholder {{EMBED_DIM}} with the constant from db.js, ensuring
-- the virtual table and the providers use exactly the same dimension.

-- Vector virtual table (sqlite-vec). The rowid is shared with `chunks`
-- (same id) for the JOIN in the hybrid query.
--
-- Metric: vec0 orders by L2 (euclidean) distance by default — we do not pass
-- `distance_metric=`. Since ALL vectors are L2-normalized (norm ≈ 1; see
-- `normalize()` in kb/embeddings.js, applied by both providers), the ranking
-- by L2 is monotonically equivalent to cosine: for unit vectors it holds that
-- L2² = 2·(1 − cos), a strictly decreasing function of cos. So "smaller L2" ==
-- "higher cosine similarity", without needing to change the DDL.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding float[{{EMBED_DIM}}]
);

-- Relational metadata per chunk. `id` matches the rowid of vec_chunks.
CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  ticket_id   TEXT    NOT NULL,
  stage       TEXT,
  kind        TEXT,
  source      TEXT,
  chunk_index INTEGER NOT NULL,
  body        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Indexes on the filter fields of the hybrid query.
CREATE INDEX IF NOT EXISTS idx_chunks_ticket ON chunks(ticket_id);
CREATE INDEX IF NOT EXISTS idx_chunks_stage  ON chunks(stage);
CREATE INDEX IF NOT EXISTS idx_chunks_kind   ON chunks(kind);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
