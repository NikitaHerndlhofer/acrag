/**
 * Idempotent ingest pipeline options + outcome (design spec §7).
 *
 * `ingestSource(source, opts)` resolves a parser/chunker via the registry,
 * then per conversation: hash-skip on unchanged source, else parse → chunk →
 * embed dirty chunks → `vecInsert` into `chunk_vec` (FTS5 sync is trigger-driven)
 * → supersede on structural replace.
 */
export interface IngestOptions {
  /** Resolved archive DB path (created on first RW open). */
  dbPath: string;
  /** Ollama host for the default embedder. */
  ollamaHost: string;
  /** Ollama embed model for the default embedder. */
  embedModel: string;
  /**
   * Test stub for the embedder. Defaults to the core's `embedBatch` against
   * `ollamaHost`/`embedModel`. Must return one `Float32Array[EMBED_DIM]` per
   * input text, in order.
   */
  embedFn?: (batch: string[]) => Promise<Float32Array[]>;
  /**
   * Optional: ingest only one conversation handle (by `ConversationHandle.id`).
   * Used by the Cursor `stop`/`subagentStop` hook path, which carries a
   * `conversation_id` and wants a targeted re-ingest of that one composer
   * from `state.vscdb` rather than a full sweep. Undefined = ingest all handles.
   */
  handleId?: string;
  /**
   * Optional parent conversation id (for subagent transcripts). Used as a
   * fallback when the parsed transcript doesn't carry one — forwarded by the
   * `acrag ingest` hook entry via `ACRAG_PARENT_CONVERSATION_ID`.
   */
  parentConversationId?: string;
}

export interface IngestOutcome {
  /** True iff at least one conversation was (re)ingested. */
  applied: boolean;
  /** Why nothing was applied (e.g. "no parser", "unchanged"). */
  reason?: string;
  /** The last conversation id touched (for single-conversation sources). */
  conversationId?: string;
}
