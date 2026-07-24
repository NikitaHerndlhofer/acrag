/**
 * Generic fallback parser — registered last in the registry (Task 7).
 *
 * Best-effort: claims ANY source (`detect` never returns null), then for a
 * `FileSource` reads `contents` line-by-line, JSON-parses each line, and pulls
 * `role` (default `"user"`) + `content`|`text` (default `""`) into one `text`
 * segment per line. Malformed lines are skipped (fail-soft) — the parser never
 * aborts a conversation on malformed input; it throws only on an unreadable
 * source (e.g. a `SqliteSource` it cannot interpret).
 */

import { createHash } from "node:crypto";
import type {
  AgentId,
  ConversationMeta,
  MessageRole,
  ParsedMessage,
  ParsedTranscript,
  Segment,
} from "../contracts/types.ts";
import type { DetectContext, Parser, ParserMatch } from "../contracts/parser.ts";
import type { ConversationHandle } from "../contracts/source.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickContent(obj: Record<string, unknown>): string {
  return asString(obj.content) ?? asString(obj.text) ?? "";
}

function pickRole(obj: Record<string, unknown>): MessageRole {
  const r = asString(obj.role);
  if (!r) return "user";
  switch (r) {
    case "user":
    case "assistant":
    case "system":
    case "tool":
      return r;
    default:
      return "user";
  }
}

function detect(ctx: DetectContext): ParserMatch {
  const agent: AgentId = ctx.agentHint ?? "cursor";
  return { agent, version: undefined, note: "generic fallback" };
}

function listConversations(ctx: DetectContext): ConversationHandle[] {
  if (ctx.source.kind !== "file") return [];
  return [{ id: ctx.source.filePath }];
}

function parse(ctx: DetectContext, handle: ConversationHandle): ParsedTranscript {
  if (ctx.source.kind !== "file") {
    throw new Error("generic parse requires a file source");
  }
  const agent: AgentId = ctx.agentHint ?? "cursor";
  const lines = ctx.source.contents.split("\n");

  // Content-aware conversation id: a changed file produces a NEW id, so the
  // ingester's supersede branch (existing.id !== conversationId) triggers.
  // segment.id / message.id stay stable (keyed on handle.id + seq) — only the
  // conversation id (and the messages' conversationId FK) track content.
  const convId = `${handle.id}:${sha256(ctx.source.contents)}`;

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
      // malformed line — skip (fail-soft)
      continue;
    }
    if (!obj) continue;

    const role = pickRole(obj);
    const content = pickContent(obj);
    const messageId = `${handle.id}:${seq}`;
    const segmentId = `${handle.id}:${seq}:0`;
    const segment: Segment = {
      id: segmentId,
      messageId,
      index: 0,
      kind: "text",
      content,
    };
    messages.push({
      id: messageId,
      conversationId: convId,
      role,
      seq,
      segments: [segment],
    });
    seq += 1;
  }

  const conversation: ConversationMeta = { id: convId, agent };
  return { conversation, messages };
}

export const parser: Parser = {
  agent: "cursor",
  versionRange: undefined,
  id: "generic",
  detect,
  listConversations,
  parse,
};
