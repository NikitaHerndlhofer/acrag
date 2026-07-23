import type { Chunk, ChunkStrategy, ParsedTranscript } from "./types.ts";

/**
 * A version-aware chunker for one (agent, versionRange), paired with its parser. The chunker turns
 * a `ParsedTranscript` into storable `Chunk`s using a strategy appropriate to that agent's segment
 * structure (e.g. keep a Cursor code block whole; pair a tool_call with its tool_result; sub-chunk
 * only oversized segments with content-aware boundaries — line-aware for code/tool-output/diff,
 * sentence-aware for prose). See design spec §5.
 *
 * One module per (agent, version) under `src/chunkers/<agent>/v<n>.ts`. Chunkers are pure
 * (no I/O, no DB, no Ollama) and deterministic given (transcript, strategy).
 */
export interface Chunker {
  /** Which agent's transcripts this chunker is for. */
  readonly agent: string;
  /** Version range this chunker handles (paired with the matching parser's range). */
  readonly versionRange?: string;
  readonly id: string;

  /**
   * Chunk a parsed transcript into storable `Chunk`s, respecting per-turn outer boundaries and
   * segment-aware sub-chunking. Large segments are SPLIT (never truncated); each split chunk
   * carries a contextual header and overlaps slightly with its neighbors (design spec §5).
   * `strategy` defaults to the chunker's own `defaultStrategy` when omitted.
   */
  chunk(transcript: ParsedTranscript, strategy?: ChunkStrategy): Chunk[];

  /** This chunker's default strategy (concrete defaults live with each chunker module). */
  readonly defaultStrategy: ChunkStrategy;
}
