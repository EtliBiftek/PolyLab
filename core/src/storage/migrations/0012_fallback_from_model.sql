-- Records the model that was replaced when a provider fallback answered, so
-- the UI can show "fallback from X" on persisted messages.

ALTER TABLE messages ADD COLUMN fallback_from_model_id TEXT;
