import type {
  AgentId,
  Chunk,
  ChunkStrategy,
  ParsedTranscript,
} from "./types.ts";
import type { DetectContext, Parser, ParserMatch } from "./parser.ts";
import type { Chunker } from "./chunker.ts";
import type { ConversationHandle } from "./source.ts";

/**
 * A parser + chunker bundled for one (agent, versionRange). The ingester resolves an adapter per
 * file via `AgentRegistry`, then runs `parser.parse` → `chunker.chunk` → embed/vec/FTS.
 */
export interface AgentAdapter {
  readonly agent: AgentId;
  readonly versionRange?: string;
  readonly parser: Parser;
  readonly chunker: Chunker;
}

/** Result of resolving a file to its adapter. */
export interface ResolvedAdapter {
  adapter: AgentAdapter;
  match: ParserMatch;
  /** True if the generic fallback adapter was used (no specific parser claimed the file). */
  fallback: boolean;
  /** Which fallback path produced this resolution (see "Version fallback" below). */
  fallbackPath: FallbackPath;
}

/**
 * The single place per-(agent, version) adapters are registered. One line per adapter; adding a
 * new agent or version = add one parser file + one chunker file + one registry line.
 * Selection is by `(agent, versionRange)`; first match wins (design spec §7).
 */
export interface AgentRegistry {
  register(adapter: AgentAdapter): void;

  /** Identify the adapter for a file: run each registered parser's `detect` in order. */
  resolve(ctx: DetectContext): ResolvedAdapter | null;

  /** Convenience: enumerate → (per handle) parse + chunk. The ingester's main entry calls this once
   *  per `ConversationHandle` (from `adapter.parser.listConversations(ctx)`). */
  parseAndChunk(
    ctx: DetectContext,
    handle: ConversationHandle,
    strategy?: ChunkStrategy,
  ): {
    transcript: ParsedTranscript;
    chunks: Chunk[];
    match: ParserMatch;
    fallback: boolean;
  } | null;
}

/** Which fallback path produced this resolution. */
export type FallbackPath =
  | "exact"
  | "nearest-below"
  | "nearest-above"
  | "generic";
