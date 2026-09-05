-- Phase 4/5: coding agent steps + per-conversation agent approval flag.
CREATE TABLE agent_steps (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  tool            TEXT NOT NULL,
  args_json       TEXT NOT NULL DEFAULT '{}',
  result          TEXT,
  ok              INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_agent_steps_message ON agent_steps (message_id, seq);

ALTER TABLE conversations ADD COLUMN agent_auto_approve INTEGER NOT NULL DEFAULT 0;
