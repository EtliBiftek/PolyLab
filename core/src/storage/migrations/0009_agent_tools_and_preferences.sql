-- Phase 11: agent safety + conversation preferences.
-- fallback_model_id: backup model used when the primary provider fails.
-- agent_plan_mode: model is prompted to plan first and summarize at the end.
-- agent_approval_profile: all | mutating | git | never ('' = legacy bool).
-- agent_steps.undo_payload: JSON snapshot to restore a file mutation.

ALTER TABLE conversations ADD COLUMN fallback_model_id TEXT;
ALTER TABLE conversations ADD COLUMN agent_plan_mode INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN agent_approval_profile TEXT NOT NULL DEFAULT 'mutating';
ALTER TABLE agent_steps ADD COLUMN undo_payload TEXT;
