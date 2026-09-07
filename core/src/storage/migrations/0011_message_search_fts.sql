-- Full-text search index over message content (SQLite FTS5, trigram tokenizer
-- so plain substring queries behave like the old LIKE search while staying
-- indexed). Kept in sync with `messages` by triggers below.
--
-- The FTS5 special 'delete' insert command misbehaves on some FTS5 builds
-- (SQL logic error), so the triggers use a plain `DELETE ... WHERE rowid`
-- instead, which is equivalent for internal-content FTS5 tables.

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  role UNINDEXED,
  model_id UNINDEXED,
  tokenize = 'trigram'
);

INSERT INTO messages_fts(rowid, content, role, model_id)
SELECT rowid, content, role, model_id FROM messages;

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, role, model_id)
  VALUES (new.rowid, new.content, new.role, new.model_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, content, role, model_id)
  VALUES (new.rowid, new.content, new.role, new.model_id);
END;
