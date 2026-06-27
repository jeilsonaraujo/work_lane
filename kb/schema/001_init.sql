-- Camada de memória (DIM-12) — schema inicial.
-- A dimensão dos vetores (EMBED_DIM) é injetada pelo runner (migrate.js)
-- substituindo o placeholder {{EMBED_DIM}} pela constante de db.js, garantindo
-- que tabela virtual e providers usem exatamente a mesma dimensão.

-- Tabela virtual vetorial (sqlite-vec). O rowid é compartilhado com `chunks`
-- (mesmo id) para JOIN na query híbrida.
--
-- Métrica: vec0 ordena por distância L2 (euclidiana) por default — não passamos
-- `distance_metric=`. Como TODOS os vetores são L2-normalizados (norma ≈ 1; ver
-- `normalize()` em kb/embeddings.js, aplicado por ambos os providers), o ranking
-- por L2 é monotonicamente equivalente a cosine: para vetores unitários vale
-- L2² = 2·(1 − cos), função estritamente decrescente em cos. Logo "menor L2" ==
-- "maior similaridade cosseno", sem precisar alterar a DDL.
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding float[{{EMBED_DIM}}]
);

-- Metadados relacionais por chunk. `id` casa com o rowid de vec_chunks.
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

-- Índices nos campos de filtro da query híbrida.
CREATE INDEX IF NOT EXISTS idx_chunks_ticket ON chunks(ticket_id);
CREATE INDEX IF NOT EXISTS idx_chunks_stage  ON chunks(stage);
CREATE INDEX IF NOT EXISTS idx_chunks_kind   ON chunks(kind);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
