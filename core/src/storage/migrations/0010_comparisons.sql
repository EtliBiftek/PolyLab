-- Phase 12: persistent model-comparison records (race/debate outputs).
-- comparisons: one saved comparison (question + optional winner).
-- comparison_entries: one column/answer per model (content + usage + cost).

CREATE TABLE comparisons (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'race',
  question         TEXT,
  winner_entry_id  TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE comparison_entries (
  id               TEXT PRIMARY KEY,
  comparison_id    TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  model_id         TEXT NOT NULL,
  resolved_model   TEXT,
  content          TEXT NOT NULL DEFAULT '',
  reasoning        TEXT,
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  tokens_estimated INTEGER,
  cost_usd         REAL,
  created_at       TEXT NOT NULL
);

CREATE INDEX idx_comparison_entries_comparison ON comparison_entries (comparison_id, id);
