-- Phase 2.1: per-model think (reasoning) toggle, set from the composer's model picker.
-- NULL = auto (follows supports_reasoning), 1 = forced on, 0 = off.
ALTER TABLE models ADD COLUMN reasoning_enabled INTEGER;
