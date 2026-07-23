-- 001_init.sql — acrag base schema
-- config is created here because the core's openArchive runs initialiseConfig
-- (INSERT INTO config / COUNT conversation) on every RW open, before any
-- consumer code; the core does not create it itself.

CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE conversation (
  id                     TEXT PRIMARY KEY,
  agent_name             TEXT NOT NULL,
  repository             TEXT,
  source_path            TEXT NOT NULL,
  file_hash              TEXT,
  parent_conversation_id TEXT,
  model                  TEXT,
  superseded_by          TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE conversation_tag (
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  tag             TEXT NOT NULL,
  PRIMARY KEY(conversation_id, tag)
);
CREATE INDEX conv_tag_tag ON conversation_tag(tag);

CREATE TABLE message (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversation(id),
  seq               INTEGER NOT NULL,
  role              TEXT NOT NULL,
  content           TEXT NOT NULL,
  tool_name         TEXT,
  tool_call_id      TEXT,
  created_at        TEXT,
  content_hash      TEXT,
  UNIQUE(conversation_id, seq)
);

CREATE TABLE segment (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL REFERENCES message(id),
  "index"          INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  content          TEXT NOT NULL,
  tool_name        TEXT,
  tool_call_id     TEXT,
  agent_transcript_path TEXT,
  UNIQUE(message_id, "index")
);
CREATE INDEX segment_msg ON segment(message_id);

CREATE TABLE chunk (
  id               INTEGER PRIMARY KEY,
  segment_id       TEXT NOT NULL REFERENCES segment(id),
  conversation_id  TEXT REFERENCES conversation(id),
  message_id       TEXT REFERENCES message(id),
  sub              INTEGER NOT NULL DEFAULT 0,
  chunk_type       TEXT NOT NULL DEFAULT 'text',
  text             TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX chunk_seg  ON chunk(segment_id);
CREATE INDEX chunk_conv ON chunk(conversation_id);
CREATE INDEX chunk_msg  ON chunk(message_id);

CREATE TRIGGER chunk_denorm_ai AFTER INSERT ON chunk
WHEN NEW.conversation_id IS NULL OR NEW.message_id IS NULL
BEGIN
  UPDATE chunk SET
    message_id      = (SELECT message_id      FROM segment WHERE id = NEW.segment_id),
    conversation_id = (SELECT conversation_id FROM message  WHERE id = (SELECT message_id FROM segment WHERE id = NEW.segment_id))
  WHERE id = NEW.id;
END;

CREATE VIRTUAL TABLE chunk_fts USING fts5(text, content='chunk', content_rowid='rowid',
  tokenize='porter unicode61');
CREATE VIRTUAL TABLE chunk_trigram USING fts5(text, content='chunk', content_rowid='rowid',
  tokenize='trigram remove_diacritics 2');

CREATE VIRTUAL TABLE chunk_vec USING vec0(
  embedding float[1024]
);

-- FTS5 sync triggers (insert/update/delete) over chunk_fts + chunk_trigram.
CREATE TRIGGER chunk_fts_ai AFTER INSERT ON chunk BEGIN
  INSERT INTO chunk_fts(rowid, text) VALUES (new.rowid, new.text);
  INSERT INTO chunk_trigram(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER chunk_fts_ad AFTER DELETE ON chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO chunk_trigram(chunk_trigram, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER chunk_fts_au AFTER UPDATE ON chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO chunk_trigram(chunk_trigram, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO chunk_fts(rowid, text) VALUES (new.rowid, new.text);
  INSERT INTO chunk_trigram(rowid, text) VALUES (new.rowid, new.text);
END;
