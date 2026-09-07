-- Phase 9: per-model pricing (USD per 1M tokens) + message feedback.
-- price_input/price_output: cost per 1M tokens in USD (NULL = not configured).
-- feedback: 1 = helpful, -1 = not helpful, NULL = no rating yet.

ALTER TABLE models ADD COLUMN price_input REAL;
ALTER TABLE models ADD COLUMN price_output REAL;
ALTER TABLE messages ADD COLUMN feedback INTEGER;
