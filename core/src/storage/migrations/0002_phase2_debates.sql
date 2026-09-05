-- Phase 2: model groups + debate persistence.

CREATE TABLE model_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE model_group_items (
  group_id TEXT NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, model_id)
);

CREATE TABLE debates (
  id                TEXT PRIMARY KEY,
  message_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status            TEXT NOT NULL,             -- running|done|cancelled|error
  rounds_total      INTEGER NOT NULL DEFAULT 0,
  consensus_reached INTEGER,
  leader_model_id   TEXT,
  settings_json     TEXT,
  total_tokens_in   INTEGER NOT NULL DEFAULT 0,
  total_tokens_out  INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT NOT NULL,
  ended_at          TEXT
);

CREATE TABLE debate_turns (
  id            TEXT PRIMARY KEY,
  debate_id     TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  model_id      TEXT NOT NULL,
  anon_label    TEXT NOT NULL,                 -- "Model A"
  content       TEXT NOT NULL DEFAULT '',
  reasoning     TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  phase         TEXT NOT NULL,                 -- initial|critique|synthesis
  consensus     INTEGER,                       -- parsed CONSENSUS vote (critique rounds)
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_debates_conversation ON debates (conversation_id, started_at);
CREATE INDEX idx_debate_turns_debate ON debate_turns (debate_id, round, created_at);
