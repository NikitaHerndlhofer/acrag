import type { AgentId, ParsedTranscript } from "./types.ts";

/** Lightweight context handed to `detect`/`parse`. */
export interface DetectContext {
  /** Absolute path to the transcript file (may carry agent hints, e.g. a `workspaceStorage` path). */
  filePath: string;
  /** The full file contents (text — transcripts are never binary; loaded whole, not streamed). */
  contents: string;
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
 * Transcripts are text and not huge, so parsers LOAD THE WHOLE FILE (`ctx.contents`) and work with
 * it directly — no line-by-line streaming (that added complexity for no benefit here). Fail-soft:
 * skip malformed lines (append races can still corrupt individual lines even in a whole-file read),
 * never abort the whole file. Throws only on unrecoverable I/O errors.
 */
export interface Parser {
  readonly agent: AgentId;
  /** Version range this parser handles, e.g. `"^1"`, `">=2.0 <3.0"`, or `undefined` for "any/default". */
  readonly versionRange?: string;
  /** Stable id for logging/registry, e.g. `"cursor:v1"`. */
  readonly id: string;

  /**
   * Sniff the file. Return a `ParserMatch` if this parser claims it, else `null`.
   * MUST NOT throw on malformed input — return `null` so the registry can try the next parser.
   * Operates on `ctx.contents` (already in memory).
   */
  detect(ctx: DetectContext): ParserMatch | null;

  /**
   * Full parse: turn `ctx.contents` → typed segments + conversation metadata.
   * Fail-soft: skip malformed lines, never abort the whole file. Throws only on unrecoverable errors.
   */
  parse(ctx: DetectContext): ParsedTranscript;
}
