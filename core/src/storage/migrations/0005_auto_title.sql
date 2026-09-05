-- Phase 3 polish: marks auto-generated titles so a model-generated title may
-- replace them later; user renames clear the flag.
ALTER TABLE conversations ADD COLUMN auto_title INTEGER NOT NULL DEFAULT 0;
