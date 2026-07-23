/** The agent applications acrag archives. */
export type AgentId = "cursor" | "claude-code" | "codex" | "opencode";

/** Message/turn role. `"tool"` is for tool-result-only turns some agents emit. */
export type MessageRole = "user" | "assistant" | "system" | "tool";

/** The kind of a typed content piece within a turn. Becomes `chunk.chunk_type`. */
export type SegmentKind =
  | "text" // user prompt or assistant prose
  | "thinking" // assistant reasoning / thinking block
  | "code" // a fenced code block
  | "tool_call" // a tool invocation
  | "tool_result" // the result of a tool_call (linked via `toolCallId`)
  | "diff" // an applied file change
  | "subagent"; // a nested subagent turn / transcript reference

/**
 * A typed content piece within a turn — the parser's atomic output and the chunker's unit of work.
 * Field names follow design spec §7 (`{role, kind, content, tool_name, tool_call_id, ...}`).
 *
 * Relational: a `Segment` belongs to a `ParsedMessage` (`messageId`); a `Chunk` belongs to a
 * `Segment` (`segmentId`). See §2 and the DB schema note in §2.
 */
export interface Segment {
  /** Stable segment id within the conversation (parser-derived; becomes `segment.id` in the DB). */
  id: string;
  /** FK → `ParsedMessage.id`. */
  messageId: string;
  /** 0-based order of this segment within its message (source order; becomes `segment.index`). */
  index: number;
  kind: SegmentKind;
  /** Full content of this segment as extracted by the parser (NOT yet chunked). */
  content: string;
  /** For `kind: "tool_call" | "tool_result"` — the tool's name. */
  toolName?: string;
  /** For `kind: "tool_call" | "tool_result"` — links a result back to its call. */
  toolCallId?: string;
  /** For `kind: "subagent"` — path/id of the nested subagent transcript (for parent-linking). */
  agentTranscriptPath?: string;
}

/** One turn in a conversation. */
export interface ParsedMessage {
  /** Stable message id within the conversation (parser-derived; becomes `message.id`). */
  id: string;
  /** FK → `ConversationMeta.id`. */
  conversationId: string;
  role: MessageRole;
  /** 0-based order within the conversation. */
  seq: number;
  /** The typed content of the turn, in source order (`Segment.index` within each). */
  segments: Segment[];
  /** ISO timestamp if the source provides one. */
  createdAt?: string;
}

/** Conversation-level metadata the parser can know. (Archive-only fields — `createdAt`,
 *  `supersededBy` — are added by the ingester, NOT by the parser.) */
export interface ConversationMeta {
  /** Stable conversation id (derived from source path/content hash by the parser). */
  id: string;
  agent: AgentId;
  /** Detected agent version (pinned + logged for deterministic re-ingest). */
  agentVersion?: string;
  /** git remote origin → repo name, else workspace basename. */
  repository?: string;
  /** Set on subagent conversations; the parser links via `Segment.agentTranscriptPath`. */
  parentConversationId?: string;
  /** Tags the parser PROPOSES (e.g. "subagent", "background"). The ingester finalizes them
   *  into the `conversation_tag` table and may add more. */
  tags?: string[];
}

/** The canonical parser output / chunker input. */
export interface ParsedTranscript {
  conversation: ConversationMeta;
  messages: ParsedMessage[];
}

/**
 * A searchable unit emitted by a chunker. Maps 1:1 to a `chunk` table row (design spec §4).
 *
 * Relational chain (matches the DB schema): `chunk.segment_id` → `segment.id` →
 * `segment.message_id` → `message.id` → `message.conversation_id` → `conversation.id`.
 * `chunk` does NOT carry denormalized `conversation_id`/`message_id` — reach them by joining up
 * through `segment`. (See open question Q1 in §8 re: denormalizing for per-conversation filters.)
 *
 * DB-assigned columns (`id`, `created_at`) are NOT emitted by the chunker. `superseded_by` lives on
 * `conversation`, not `chunk`.
 */
export interface Chunk {
  /** FK → `Segment.id`. */
  segmentId: string;
  /** Sub-chunk index when an oversized segment is split; `0` for an unsplit segment. */
  sub: number;
  /** The `SegmentKind` of the source segment → `chunk.chunk_type`. */
  chunkType: SegmentKind;
  /** Full chunk text. For split chunks this INCLUDES the contextual header the chunker prepends. */
  text: string;
  /** Stable hash of `text` for idempotent re-embedding (unchanged chunks skip re-embed). */
  contentHash: string;
}

/**
 * Tunable parameters for a chunker. The unit (tokens vs words vs chars vs lines) is chosen by the
 * chunker (a code-heavy agent may chunk by lines/tokens; a prose-heavy one by sentences/words).
 *
 * **Control is inverted to the consumer.** The ingester/frontend passes the `ChunkStrategy` on
 * every call and can override ANY field; the chunker's own `defaultStrategy` (see §5) is used ONLY
 * when the consumer omits `strategy`. A per-(agent, version) chunker MAY extend `ChunkStrategy`
 * with its own fields (its own knobs); the base fields below are the common ones the ingester
 * stores in `config` to detect strategy changes (→ rechunk). The chunker treats `strategy` as
 * opaque beyond the base fields — it reads its own extended fields off the same object.
 */
export interface ChunkStrategy {
  /** Max size (in the chunker's chosen unit) before a segment is sub-chunked. */
  maxSegmentSize: number;
  /** Overlap between adjacent sub-chunks of one oversized segment (chunker's unit). */
  overlap: number;
  /** At or below this size a segment stays a single chunk (no sub-chunking). */
  threshold: number;
  /** Bump when the chunker's BEHAVIOR (not parameters) changes — triggers a rechunk. */
  algoVersion: number;
}

/** Default strategy for the Cursor v1 chunker (concrete defaults live with each chunker, not here). */
// export const DEFAULT_CURSOR_V1_STRATEGY: ChunkStrategy = { ... }  // defined in the chunker module
