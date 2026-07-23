import type { AgentId, ParsedTranscript } from "./types.ts";
import type { ArchiveSource, ConversationHandle } from "./source.ts";

/** Lightweight context handed to `detect`/`listConversations`/`parse`. */
export interface DetectContext {
  /** The source to read from (a per-file text source, or a shared SQLite DB like Cursor's). */
  source: ArchiveSource;
  /** Hint from the ingester if it already knows the agent (e.g. from hook metadata / source dir). */
  agentHint?: AgentId;
}

/** A non-null `detect` result: this parser claims the file, at the given version. */
export interface ParserMatch {
  agent: AgentId;
  /** Detected version string (pinned + logged). `undefined` means "unknown version — best-effort". */
  version?: string;
  /** Confidence/notes for logging (e.g. which heuristic matched). */
  note?: string;
}

/**
 * A version-aware parser for one (agent, versionRange). Implementations live one-per-file under
 * `src/parsers/<agent>/v<n>.ts`. Parsers MUST be deterministic and side-effect-free.
 *
 * Source model: a parser claims a *source* (`detect`), enumerates its conversations
 * (`listConversations`), and parses ONE conversation per call (`parse(handle)`). For `FileSource`
 * the whole file is one conversation (the ingester loads `contents` into memory — no streaming).
 * For `SqliteSource` (Cursor) the parser opens the DB **read-only** and queries by `composerId`.
 * Fail-soft: skip malformed bubbles/lines (append races can corrupt individual rows), never abort the
 * whole conversation. Throws only on unrecoverable I/O errors.
 */
export interface Parser {
  readonly agent: AgentId;
  /** Version range this parser handles, e.g. `"^1"`, `">=2.0 <3.0"`, or `undefined` for "any/default". */
  readonly versionRange?: string;
  /** Stable id for logging/registry, e.g. `"cursor:v1"`. */
  readonly id: string;

  /**
   * Sniff the source. Return a `ParserMatch` if this parser claims it, else `null`.
   * MUST NOT throw on malformed input — return `null` so the registry can try the next parser.
   * For `SqliteSource` this inspects table names / a sample row's `_v`; for `FileSource`, path + shape.
   */
  detect(ctx: DetectContext): ParserMatch | null;

  /**
   * Enumerate the conversations in the source (Cursor: `composerId`s from `composerHeaders`;
   * per-file agent: the single file). Cheap metadata (e.g. `lastUpdatedAt`, `isArchived`) may be
   * attached to each `ConversationHandle.meta` for idempotency/skip decisions.
   */
  listConversations(ctx: DetectContext): ConversationHandle[];

  /**
   * Full parse of ONE conversation (by `handle`) → typed segments + conversation metadata.
   * Fail-soft: skip malformed bubbles/lines, never abort the conversation. Throws only on
   * unrecoverable I/O errors.
   */
  parse(ctx: DetectContext, handle: ConversationHandle): ParsedTranscript;
}
