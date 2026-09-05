-- Phase 1 schema (plan §3 subset): providers, models, conversations, messages,
-- settings, folders. Debates/agent tables arrive with their phases.

CREATE TABLE providers (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  base_url    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE models (
  id                     TEXT PRIMARY KEY,
  provider_id            TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id               TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  color                  TEXT,
  temperature            REAL,
  max_tokens             INTEGER,
  system_prompt_override TEXT,
  supports_vision        INTEGER NOT NULL DEFAULT 0,
  supports_tools         INTEGER NOT NULL DEFAULT 0,
  supports_reasoning     INTEGER NOT NULL DEFAULT 0,
  enabled                INTEGER NOT NULL DEFAULT 1,
  UNIQUE (provider_id, model_id)
);

CREATE TABLE conversations (
  id                   TEXT PRIMARY KEY,
  title                TEXT,
  mode                 TEXT NOT NULL DEFAULT 'chat',
  selection_type       TEXT NOT NULL DEFAULT 'single',
  model_id             TEXT REFERENCES models(id) ON DELETE SET NULL,
  group_id             TEXT,
  debate_settings_json TEXT,
  project_path         TEXT,
  folder_id            TEXT,
  pinned               INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL DEFAULT '',
  reasoning        TEXT,
  model_id         TEXT,
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  tokens_estimated INTEGER,
  attachments_json TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE folders (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX idx_conversations_updated ON conversations (updated_at DESC);
