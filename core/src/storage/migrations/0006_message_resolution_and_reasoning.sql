-- Phase 8: message model resolution + per-model reasoning effort.
-- resolved_model: the concrete model id the provider actually served (e.g.
-- OpenRouter resolves the 'free' alias to a real model) — shown in the UI.
-- reasoning_options: JSON array of selectable effort levels (e.g. ["low","medium","high"]).
-- reasoning_effort: the currently selected effort level (null = provider default).

ALTER TABLE messages ADD COLUMN resolved_model TEXT;
ALTER TABLE models ADD COLUMN reasoning_options TEXT;
ALTER TABLE models ADD COLUMN reasoning_effort TEXT;
ALTER TABLE debate_turns ADD COLUMN resolved_model TEXT;
