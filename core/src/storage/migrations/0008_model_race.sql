-- Phase 10: model race (same prompt → N models in parallel, side-by-side).
-- race_id groups the per-model assistant messages of one race run; the
-- conversation's group_id holds the participant set with selection_type='race'.

ALTER TABLE messages ADD COLUMN race_id TEXT;
