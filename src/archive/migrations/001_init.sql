-- 001_init: baseline tables the core's openArchive expects on every RW open.
-- initialiseConfig() INSERTs into `config` and COUNTs the freshness table
-- (`conversation`); both must exist before the wrapper seeds config.
-- Task 002 expands `conversation` with its full column set and adds
-- message / segment / chunk / FTS5 / vec0.

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE conversation (
  id INTEGER PRIMARY KEY
);
