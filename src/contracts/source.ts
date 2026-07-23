/** A source of conversations. Parsers read only the fields their `kind` needs. */
export interface FileSource {
  kind: "file";
  /** Absolute path to the transcript file (one conversation per file). */
  filePath: string;
  /** Whole file contents (text). Loaded by the ingester for `file`-kind sources. */
  contents: string;
}

export interface SqliteSource {
  kind: "sqlite";
  /** Absolute path to the SQLite DB holding many conversations (e.g. Cursor `state.vscdb`). */
  dbPath: string;
}

export type ArchiveSource = FileSource | SqliteSource;

/** A handle to one conversation within a source — the unit of parsing. */
export interface ConversationHandle {
  /** Stable id within the source (`composerId` for Cursor; `filePath` for a per-file agent). */
  id: string;
  /** Cheap source-side hints the enumerator can pass along (e.g. `lastUpdatedAt`, `isArchived`). */
  meta?: Record<string, unknown>;
}
