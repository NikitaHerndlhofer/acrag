CREATE TABLE subagent_map (
  subagent_id            TEXT PRIMARY KEY,
  parent_conversation_id TEXT,
  subagent_type          TEXT,
  task                   TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
