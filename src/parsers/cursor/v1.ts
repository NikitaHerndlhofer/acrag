/**
 * Cursor v1 parser — confirmed on-disk mapping (live state.vscdb, 2026-07-23):
 *
 * DB: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 * Tables: composerHeaders, cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
 *
 * Conversation = composerHeaders row (composerId, workspaceId, createdAt, lastUpdatedAt,
 *   isArchived, isSubagent, recency, checkpointAt, value[JSON])
 *   + cursorDiskKV `composerData:<composerId>`
 *   + cursorDiskKV `bubbleId:<composerId>:<bubbleId>` (N rows)
 *
 * composerData fields:
 *   status, text, richText, fullConversationHeadersOnly[{bubbleId,type,serverBubbleId,grouping}],
 *   conversationMap, context, codeBlockData, originalFileStates, _v
 * Version pin: `v${composerData._v}` (live sample _v=17)
 *
 * Bubble order: composerData.fullConversationHeadersOnly (ordered).
 * Fetch bubbles by EXACT key bubbleId:<composerId>:<bubbleId> (no LIKE scans).
 *
 * int→MessageRole (bubble.type / header.type):
 *   1 → user
 *   2 → assistant
 *   3 → system (if present)
 *   4 → tool (if present)
 *   else → assistant (logged)
 *
 * Content locations (confirmed live):
 *   user prompt     → bubble.text (primary) / bubble.richText (fallback; often longer)
 *   assistant prose → bubble.text (primary; richText often empty)
 *   thinking        → bubble.allThinkingBlocks[] (.thinking / .text / .content)
 *   code            → bubble.suggestedCodeBlocks[] (.code / .content / .text)
 *   tool_call       → bubble.toolFormerData { name, toolCallId, rawArgs|params }
 *                     (live: toolFormerData is the real tool-call carrier)
 *   tool_result     → bubble.toolResults[] (.content/.result + toolCallId/tool_call_id)
 *                     or toolFormerData.result when present
 *   diff            → bubble.gitDiffs[] / bubble.assistantSuggestedDiffs[] (.diff/.content)
 *
 * composerHeaders.value JSON:
 *   trackedGitRepos[], workspaceIdentifier{id,uri}, name, subtitle,
 *   isWorktree, isSpec, numSubComposers, subagentInfo
 * repository ← first trackedGitRepo remote → repo name, else workspaceIdentifier.uri basename
 * parentConversationId ← only when isSubagent=1 (if derivable; else undefined)
 */

import { Database } from "bun:sqlite";
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
import { ensureExtensionCapableSqlite } from "../../archive/open.ts";

function openRo(dbPath: string): Database {
  // Bun locks the process SQLite at first `new Database`. Call ensure first so
  // later suite tests that need vec0/loadExtension are not poisoned by Apple's SQLite.
  ensureExtensionCapableSqlite();
  return new Database("file:" + dbPath + "?mode=ro", { readonly: true });
}

function blobToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value && typeof value === "object" && "buffer" in (value as object)) {
    return new TextDecoder().decode(value as Uint8Array);
  }
  return String(value ?? "");
}

function parseJson(value: unknown): unknown | null {
  try {
    return JSON.parse(blobToString(value));
  } catch {
    return null;
  }
}

function tablesExist(db: Database): boolean {
  const rows = db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('composerHeaders','cursorDiskKV')`,
    )
    .all() as Array<{ name: string }>;
  const names = new Set(rows.map((r) => r.name));
  return names.has("composerHeaders") && names.has("cursorDiskKV");
}

function getKv(db: Database, key: string): unknown | null {
  const row = db
    .query(`SELECT value FROM cursorDiskKV WHERE key = ?`)
    .get(key) as { value: unknown } | null;
  if (!row) return null;
  return parseJson(row.value);
}

function typeToRole(type: unknown): MessageRole {
  const n = typeof type === "number" ? type : Number(type);
  if (n === 1) return "user";
  if (n === 2) return "assistant";
  if (n === 3) return "system";
  if (n === 4) return "tool";
  console.warn(`[cursor:v1] unknown bubble.type=${String(type)}; falling back to assistant`);
  return "assistant";
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickText(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    const s = asString(c);
    if (s) return s;
  }
  return undefined;
}

// Cursor bubble.createdAt is an ISO STRING in real data; composerHeaders.createdAt/lastUpdatedAt are
// epoch-ms NUMBERS. Accept either, fail-soft on garbage.
function toIsoCreatedAt(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "number") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof raw === "string") {
    if (raw.length === 0) return undefined;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toISOString();
  }
  return undefined;
}

function repoFromRemote(remote: string): string {
  const trimmed = remote.replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = trimmed.split(/[/:]/);
  return parts[parts.length - 1] || trimmed;
}

function repositoryFromHeaderValue(value: Record<string, unknown> | null): string | undefined {
  if (!value) return undefined;
  const roots = value.trackedGitRepos;
  if (Array.isArray(roots) && roots.length > 0) {
    const first = roots.find((r) => typeof r === "string" && r.length > 0);
    if (typeof first === "string") return repoFromRemote(first);
  }
  const ws = value.workspaceIdentifier;
  if (ws && typeof ws === "object") {
    const uri = (ws as { uri?: unknown }).uri;
    if (typeof uri === "string" && uri.length > 0) {
      const base = uri.replace(/\/+$/, "").split("/").pop();
      if (base) return base;
    }
    const id = (ws as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

function parentFromSubagent(
  isSubagent: unknown,
  headerValue: Record<string, unknown> | null,
  composerData: Record<string, unknown>,
): string | undefined {
  if (isSubagent !== 1 && isSubagent !== true) return undefined;
  const info = headerValue?.subagentInfo;
  if (info && typeof info === "object") {
    const o = info as Record<string, unknown>;
    const p = pickText(o.parentComposerId, o.parentConversationId, o.composerId);
    if (p) return p;
  }
  const ctx = composerData.context;
  if (ctx && typeof ctx === "object") {
    const o = ctx as Record<string, unknown>;
    const p = pickText(o.parentComposerId, o.parentConversationId, o.parentId);
    if (p) return p;
  }
  return undefined;
}

function pushSeg(
  segs: Omit<Segment, "id" | "messageId" | "index">[],
  kind: SegmentKind,
  content: string | undefined,
  extra?: Partial<Pick<Segment, "toolName" | "toolCallId" | "agentTranscriptPath">>,
): void {
  if (!content || content.length === 0) return;
  segs.push({ kind, content, ...extra });
}

function extractSegments(bubble: Record<string, unknown>): Omit<Segment, "id" | "messageId" | "index">[] {
  const segs: Omit<Segment, "id" | "messageId" | "index">[] = [];

  const prose = pickText(bubble.text, bubble.richText);
  pushSeg(segs, "text", prose);

  const thinking = Array.isArray(bubble.allThinkingBlocks) ? bubble.allThinkingBlocks : [];
  for (const block of thinking) {
    if (!block || typeof block !== "object") continue;
    const o = block as Record<string, unknown>;
    pushSeg(segs, "thinking", pickText(o.thinking, o.text, o.content, o.reasoning));
  }

  const codes = Array.isArray(bubble.suggestedCodeBlocks) ? bubble.suggestedCodeBlocks : [];
  for (const block of codes) {
    if (!block || typeof block !== "object") continue;
    const o = block as Record<string, unknown>;
    pushSeg(segs, "code", pickText(o.code, o.content, o.text));
  }

  // Live Cursor: tool_call lives on toolFormerData
  const tfd = bubble.toolFormerData;
  if (tfd && typeof tfd === "object") {
    const o = tfd as Record<string, unknown>;
    const toolCallId = pickText(o.toolCallId, o.tool_call_id);
    const toolName = pickText(o.name, o.toolName, o.tool_name);
    const args = pickText(o.rawArgs, o.params, o.args);
    pushSeg(segs, "tool_call", args ?? toolName ?? toolCallId, { toolName, toolCallId });
    const result = pickText(
      typeof o.result === "string" ? o.result : undefined,
      o.content,
    );
    // Prefer dedicated toolResults rows when present; only emit tfd.result if no toolResults
    const toolResults = Array.isArray(bubble.toolResults) ? bubble.toolResults : [];
    if (result && toolResults.length === 0) {
      pushSeg(segs, "tool_result", result, { toolName, toolCallId });
    }
  }

  const toolResults = Array.isArray(bubble.toolResults) ? bubble.toolResults : [];
  for (const tr of toolResults) {
    if (!tr || typeof tr !== "object") continue;
    const o = tr as Record<string, unknown>;
    const toolCallId = pickText(o.toolCallId, o.tool_call_id);
    const toolName = pickText(o.toolName, o.tool_name, o.name);
    // Some rows encode the call itself
    const callArgs = pickText(o.rawArgs, o.params, o.args, o.arguments);
    if (callArgs && !tfd) {
      pushSeg(segs, "tool_call", callArgs, { toolName, toolCallId });
    }
    pushSeg(
      segs,
      "tool_result",
      pickText(
        typeof o.result === "string" ? o.result : undefined,
        o.content,
        o.output,
        o.text,
      ),
      { toolName, toolCallId },
    );
  }

  for (const key of ["gitDiffs", "assistantSuggestedDiffs"] as const) {
    const diffs = Array.isArray(bubble[key]) ? bubble[key] : [];
    for (const d of diffs) {
      if (!d || typeof d !== "object") continue;
      const o = d as Record<string, unknown>;
      pushSeg(segs, "diff", pickText(o.diff, o.content, o.text, o.patch));
    }
  }

  return segs;
}

function detect(ctx: DetectContext): ParserMatch | null {
  try {
    if (ctx.source.kind !== "sqlite") return null;
    const db = openRo(ctx.source.dbPath);
    try {
      if (!tablesExist(db)) return null;
      let version = "v1";
      let note = "composerHeaders+cursorDiskKV present";
      const sampleHeader = db
        .query(`SELECT composerId FROM composerHeaders LIMIT 1`)
        .get() as { composerId: string } | null;
      if (sampleHeader?.composerId) {
        const cd = getKv(db, `composerData:${sampleHeader.composerId}`) as Record<
          string,
          unknown
        > | null;
        if (cd && typeof cd._v === "number") {
          version = `v${cd._v}`;
          note = `composerData._v=${cd._v}`;
        }
      }
      return { agent: "cursor", version, note };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function listConversations(ctx: DetectContext): ConversationHandle[] {
  if (ctx.source.kind !== "sqlite") return [];
  const db = openRo(ctx.source.dbPath);
  try {
    if (!tablesExist(db)) return [];
    const rows = db
      .query(
        `SELECT composerId, lastUpdatedAt, isArchived, isSubagent FROM composerHeaders`,
      )
      .all() as Array<{
      composerId: string;
      lastUpdatedAt: number | null;
      isArchived: number | null;
      isSubagent: number | null;
    }>;
    return rows.map((r) => ({
      id: r.composerId,
      meta: {
        lastUpdatedAt: r.lastUpdatedAt,
        isArchived: r.isArchived,
        isSubagent: r.isSubagent,
      },
    }));
  } finally {
    db.close();
  }
}

function parse(ctx: DetectContext, handle: ConversationHandle): ParsedTranscript {
  if (ctx.source.kind !== "sqlite") {
    throw new Error("cursor:v1 parse requires a sqlite source");
  }
  const db = openRo(ctx.source.dbPath);
  try {
    const composerData = getKv(db, `composerData:${handle.id}`) as Record<
      string,
      unknown
    > | null;
    if (!composerData) {
      return {
        conversation: { id: handle.id, agent: "cursor" },
        messages: [],
      };
    }

    const headerRow = db
      .query(
        `SELECT isSubagent, value, createdAt, lastUpdatedAt FROM composerHeaders WHERE composerId = ?`,
      )
      .get(handle.id) as {
      isSubagent: number | null;
      value: unknown;
      createdAt: number | null;
      lastUpdatedAt: number | null;
    } | null;

    const headerValue = headerRow?.value
      ? (parseJson(headerRow.value) as Record<string, unknown> | null)
      : null;

    const agentVersion =
      typeof composerData._v === "number" ? `v${composerData._v}` : undefined;

    const isSubagent = headerRow?.isSubagent ?? handle.meta?.isSubagent;
    const conversation: ConversationMeta = {
      id: handle.id,
      agent: "cursor",
      agentVersion,
      repository: repositoryFromHeaderValue(headerValue),
      parentConversationId: parentFromSubagent(
        isSubagent,
        headerValue,
        composerData,
      ),
      // Parser proposes only tags it can derive from the source; hook-metadata tags
      // (e.g. "background") are added by the ingester at finalize time.
      tags: isSubagent === 1 || isSubagent === true ? ["subagent"] : undefined,
    };

    const headers = Array.isArray(composerData.fullConversationHeadersOnly)
      ? composerData.fullConversationHeadersOnly
      : [];

    const messages: ParsedMessage[] = [];
    let seq = 0;

    for (const hdr of headers) {
      if (!hdr || typeof hdr !== "object") continue;
      const h = hdr as Record<string, unknown>;
      const bid = asString(h.bubbleId);
      if (!bid) continue;

      const bubble = getKv(db, `bubbleId:${handle.id}:${bid}`) as Record<
        string,
        unknown
      > | null;
      if (!bubble) continue; // missing / malformed skip

      const role = typeToRole(bubble.type ?? h.type);
      const rawSegs = extractSegments(bubble);
      if (rawSegs.length === 0) continue;

      const messageId = `${handle.id}:${seq}`;
      const segments: Segment[] = rawSegs.map((s, index) => ({
        ...s,
        id: `${handle.id}:${bid}:${index}`,
        messageId,
        index,
      }));

      messages.push({
        id: messageId,
        conversationId: handle.id,
        role,
        seq,
        segments,
        createdAt: toIsoCreatedAt(bubble.createdAt ?? h.createdAt),
      });
      seq += 1;
    }

    return { conversation, messages };
  } finally {
    db.close();
  }
}

export const parser: Parser = {
  agent: "cursor",
  versionRange: "^1",
  id: "cursor:v1",
  detect,
  listConversations,
  parse,
};
