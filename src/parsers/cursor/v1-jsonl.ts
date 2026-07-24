/**
 * Cursor v1 JSONL transcript parser — on-disk `agent-transcripts` files.
 *
 * Path shape:
 *   ~/.cursor/projects/<workspace>/agent-transcripts/<convId>/<convId>.jsonl
 *   ~/.cursor/projects/<workspace>/agent-transcripts/<convId>/subagents/<subId>.jsonl
 *
 * Each line is one Anthropic-style message event:
 *   {"role":"user|assistant|system|tool","message":{"content":[{"type":"text|tool_use|tool_result|thinking","text":"…","name":"…","input":{…},"tool_use_id":"…"}]}}
 *
 * The conversation id is the UUID basename (sans `.jsonl`), which equals the
 * `composerId` the sqlite parser (cursor/v1) uses for the same chat in
 * `state.vscdb`. That shared id is what lets `acrag index` dedupe a chat that
 * exists in BOTH sources (sqlite wins; the JSONL sweep skips it).
 *
 * Fail-soft: malformed lines are skipped, never abort the conversation.
 */
import { basename, dirname } from "node:path";
import type {
  ConversationMeta,
  MessageRole,
  ParsedMessage,
  ParsedTranscript,
  Segment,
  SegmentKind,
} from "../../contracts/types.ts";
import type {
  DetectContext,
  Parser,
  ParserMatch,
} from "../../contracts/parser.ts";
import type { ConversationHandle } from "../../contracts/source.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function conversationIdFromPath(filePath: string): string | undefined {
  const base = basename(filePath).replace(/\.jsonl$/i, "");
  return UUID.test(base) ? base : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** First non-empty line without splitting the whole (possibly huge) file. */
function firstNonEmptyLine(contents: string): string | undefined {
  let start = 0;
  while (start < contents.length) {
    const nl = contents.indexOf("\n", start);
    const line = nl === -1 ? contents.slice(start) : contents.slice(start, nl);
    if (line.trim().length > 0) return line;
    if (nl === -1) return undefined;
    start = nl + 1;
  }
  return undefined;
}

/** Does this file look like a Cursor JSONL transcript event stream? */
function looksLikeCursorEvent(line: string | undefined): boolean {
  if (!line) return false;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.role !== "string") return false;
  const msg = o.message;
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return Array.isArray(m.content) || typeof m.content === "string";
}

function toRole(role: unknown): MessageRole {
  const r = asString(role);
  switch (r) {
    case "user":
    case "assistant":
    case "system":
    case "tool":
      return r;
    default:
      return "assistant";
  }
}

/** Flatten a tool_result `content` (string | array of {type,text}) to text. */
function flattenContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = asString(b.text) ?? asString(b.content);
    if (t) parts.push(t);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function blockToSegment(
  block: Record<string, unknown>,
  messageId: string,
  index: number,
  convId: string,
): Omit<Segment, "id" | "messageId" | "index"> | undefined {
  const type = asString(block.type);
  if (type === "text") {
    const content = asString(block.text);
    return content ? { kind: "text" as SegmentKind, content } : undefined;
  }
  if (type === "thinking") {
    const content = asString(block.thinking) ?? asString(block.text) ?? asString(block.content);
    return content ? { kind: "thinking" as SegmentKind, content } : undefined;
  }
  if (type === "tool_use") {
    const toolName = asString(block.name) ?? asString(block.toolName);
    const toolCallId = asString(block.id) ?? asString(block.toolCallId);
    const args =
      asString(block.input) ??
      (block.input !== undefined ? JSON.stringify(block.input) : undefined);
    const content = args ?? toolName ?? toolCallId;
    return content
      ? { kind: "tool_call" as SegmentKind, content, toolName, toolCallId }
      : undefined;
  }
  if (type === "tool_result") {
    const toolCallId = asString(block.tool_use_id) ?? asString(block.toolCallId);
    const toolName = asString(block.toolName) ?? asString(block.name);
    const content = flattenContent(block.content) ?? asString(block.result);
    return content
      ? { kind: "tool_result" as SegmentKind, content, toolName, toolCallId }
      : undefined;
  }
  // Unrecognized block type — fail-soft skip.
  return undefined;
}

/** Best-effort repo name from the workspace folder (`Users-…-<repo>` → `<repo>`). */
function repositoryFromPath(filePath: string): string | undefined {
  // …/<workspace>/agent-transcripts/<convId>(/<file>)  →  workspace = two dirs up from the id dir
  const idDir = dirname(filePath);
  const transcriptsDir = dirname(idDir);
  const workspaceDir = dirname(transcriptsDir);
  const ws = basename(workspaceDir);
  if (!ws || ws === "agent-transcripts") return undefined;
  const segs = ws.split("-");
  return segs.length > 1 ? segs[segs.length - 1] : ws;
}

/** Parent conversation id when this is a subagent transcript (`…/<convId>/subagents/<subId>.jsonl`). */
function parentFromPath(filePath: string, convId: string): string | undefined {
  // filePath  = …/<convId>/subagents/<subId>.jsonl
  // dir       = …/<convId>/subagents   (basename must be "subagents")
  // convDir   = …/<convId>             (basename is the parent conversation id)
  const subagentsDir = dirname(filePath);
  if (basename(subagentsDir) !== "subagents") return undefined;
  const convDir = dirname(subagentsDir);
  const candidate = basename(convDir);
  return UUID.test(candidate) && candidate !== convId ? candidate : undefined;
}

function detect(ctx: DetectContext): ParserMatch | null {
  if (ctx.source.kind !== "file") return null;
  const id = conversationIdFromPath(ctx.source.filePath);
  if (!id) return null;
  if (!looksLikeCursorEvent(firstNonEmptyLine(ctx.source.contents))) return null;
  return { agent: "cursor", version: "v1", note: "cursor jsonl transcript" };
}

function listConversations(ctx: DetectContext): ConversationHandle[] {
  if (ctx.source.kind !== "file") return [];
  const id = conversationIdFromPath(ctx.source.filePath);
  return id ? [{ id }] : [];
}

function parse(ctx: DetectContext, handle: ConversationHandle): ParsedTranscript {
  if (ctx.source.kind !== "file") {
    throw new Error("cursor:v1-jsonl parse requires a file source");
  }
  const convId = conversationIdFromPath(ctx.source.filePath) ?? handle.id;
  const lines = ctx.source.contents.split("\n");

  const conversation: ConversationMeta = {
    id: convId,
    agent: "cursor",
    repository: repositoryFromPath(ctx.source.filePath),
    parentConversationId: parentFromPath(ctx.source.filePath, convId),
  };

  const messages: ParsedMessage[] = [];
  let seq = 0;

  for (const line of lines) {
    if (line.length === 0) continue;
    let obj: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      continue; // malformed line — fail-soft
    }
    if (!obj) continue;

    const role = toRole(obj.role);
    const msg = obj.message as Record<string, unknown> | undefined;
    const rawBlocks = msg?.content;
    const blocks: Record<string, unknown>[] = Array.isArray(rawBlocks)
      ? (rawBlocks as Record<string, unknown>[])
      : typeof rawBlocks === "string"
        ? [{ type: "text", text: rawBlocks }]
        : [];

    const rawSegs: Omit<Segment, "id" | "messageId" | "index">[] = [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      const seg = blockToSegment(b, "", 0, convId);
      if (seg) rawSegs.push(seg);
    }
    if (rawSegs.length === 0) continue;

    const messageId = `${convId}:${seq}`;
    const segments: Segment[] = rawSegs.map((s, index) => ({
      ...s,
      id: `${convId}:${seq}:${index}`,
      messageId,
      index,
    }));

    messages.push({
      id: messageId,
      conversationId: convId,
      role,
      seq,
      segments,
    });
    seq += 1;
  }

  return { conversation, messages };
}

export const parser: Parser = {
  agent: "cursor",
  versionRange: "^1",
  id: "cursor:v1-jsonl",
  detect,
  listConversations,
  parse,
};
