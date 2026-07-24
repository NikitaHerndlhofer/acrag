/**
 * Idempotent ingest pipeline (design spec §7, adapted to the source model).
 *
 * `ingestSource(source, opts)` resolves a parser/chunker via the registry, then
 * per conversation: hash-skip on unchanged source, else parse → chunk → embed
 * dirty chunks → `vecInsert` into `chunk_vec` (FTS5 sync is trigger-driven) →
 * supersede on structural replace. Diff by `content_hash`; the fast path
 * populates `chunk.conversation_id`/`chunk.message_id` so the `chunk_denorm_ai`
 * trigger's NULL guard is a no-op for normal inserts.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  embedBatch,
  embedTexts,
  vecDelete,
  vecInsert,
  runUpdaters,
  createLogger,
  type Logger,
} from "agent-archive-core";
import { openArchive } from "../archive/open.ts";
import { UPDATERS } from "../archive/updaters.ts";
import { EMBED_BATCH_SIZE } from "../config.ts";
import { buildDefaultRegistry } from "./registry.ts";
import type { ArchiveSource, ConversationHandle } from "../contracts/source.ts";
import type { Chunk, ParsedTranscript, Segment } from "../contracts/types.ts";
import type { IngestOptions, IngestOutcome } from "./types.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Stable per-message hash over its segments (kind/content/toolName/toolCallId, in order). */
function messageContentHash(segments: Segment[]): string {
  const serial = segments.map((s) => ({
    kind: s.kind,
    content: s.content,
    toolName: s.toolName ?? null,
    toolCallId: s.toolCallId ?? null,
  }));
  return sha256(JSON.stringify(serial));
}

function segmentContentHash(segments: Segment[]): string {
  return segments.map((s) => s.content).join("\n");
}

/**
 * Per-conversation idempotency key.
 *
 * FileSource: sha256(contents) — a changed file produces a new hash (and the
 * generic parser derives a new conversation id, so the supersede branch fires).
 * SqliteSource (Cursor state.vscdb): a cheap version key from the handle's
 * `listConversations` meta (`lu:<lastUpdatedAt>`). The Cursor parser already
 * surfaces `lastUpdatedAt` per composer, so we skip unchanged composers without
 * re-reading their bubbles. An empty key means "unknown" — the caller re-ingests
 * (never skips) so a null `lastUpdatedAt` can't mask a real change.
 */
function fingerprintConversation(
  source: ArchiveSource,
  handle: ConversationHandle,
): string {
  if (source.kind === "file") {
    return sha256(source.contents);
  }
  const lu = handle.meta?.lastUpdatedAt;
  if (typeof lu === "number") return `lu:${lu}`;
  if (typeof lu === "string" && lu.length > 0) return `lu:${lu}`;
  return "";
}

interface ExistingConversation {
  id: string;
  file_hash: string | null;
}

function lookupActiveConversation(
  db: Database,
  sourcePath: string,
): ExistingConversation | undefined {
  return db
    .prepare(
      "SELECT id, file_hash FROM conversation WHERE source_path = ? AND superseded_by IS NULL",
    )
    .get(sourcePath) as ExistingConversation | undefined;
}

function upsertConversation(
  db: Database,
  t: ParsedTranscript,
  sourcePath: string,
  fileHash: string,
  parentConversationId?: string,
): void {
  const c = t.conversation;
  db.prepare(
    "INSERT INTO conversation (id, agent_name, repository, source_path, file_hash, parent_conversation_id, model) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "agent_name = excluded.agent_name, repository = excluded.repository, " +
      "source_path = excluded.source_path, file_hash = excluded.file_hash, " +
      "parent_conversation_id = excluded.parent_conversation_id, model = excluded.model",
  ).run(
    c.id,
    c.agent,
    c.repository ?? null,
    sourcePath,
    fileHash,
    c.parentConversationId ?? parentConversationId ?? null,
    null,
  );
}

function replaceTags(db: Database, t: ParsedTranscript): void {
  const tags = t.conversation.tags ?? [];
  db.prepare("DELETE FROM conversation_tag WHERE conversation_id = ?").run(
    t.conversation.id,
  );
  if (tags.length > 0) {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO conversation_tag (conversation_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) ins.run(t.conversation.id, tag);
  }
}

function upsertSegment(db: Database, seg: Segment): void {
  db.prepare(
    'INSERT INTO segment (id, message_id, "index", kind, content, tool_name, tool_call_id, agent_transcript_path) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      'message_id = excluded.message_id, "index" = excluded."index", kind = excluded.kind, ' +
      "content = excluded.content, tool_name = excluded.tool_name, " +
      "tool_call_id = excluded.tool_call_id, agent_transcript_path = excluded.agent_transcript_path",
  ).run(
    seg.id,
    seg.messageId,
    seg.index,
    seg.kind,
    seg.content,
    seg.toolName ?? null,
    seg.toolCallId ?? null,
    seg.agentTranscriptPath ?? null,
  );
}

function upsertMessage(
  db: Database,
  msgId: string,
  conversationId: string,
  seq: number,
  role: string,
  content: string,
  contentHash: string,
  createdAt: string | null,
  toolName: string | null,
  toolCallId: string | null,
): void {
  db.prepare(
    "INSERT INTO message (id, conversation_id, seq, role, content, tool_name, tool_call_id, created_at, content_hash) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "conversation_id = excluded.conversation_id, seq = excluded.seq, role = excluded.role, " +
      "content = excluded.content, tool_name = excluded.tool_name, tool_call_id = excluded.tool_call_id, " +
      "created_at = excluded.created_at, content_hash = excluded.content_hash",
  ).run(
    msgId,
    conversationId,
    seq,
    role,
    content,
    toolName,
    toolCallId,
    createdAt,
    contentHash,
  );
}

/** Delete all chunk rows for a segment + their chunk_vec entries (by rowid). */
function purgeSegmentChunks(db: Database, segmentId: string): void {
  const oldIds = db
    .prepare("SELECT id FROM chunk WHERE segment_id = ?")
    .all(segmentId) as { id: number }[];
  for (const { id } of oldIds) {
    vecDelete(db, { table: "chunk_vec", keyColumn: "rowid", key: id });
  }
  db.prepare("DELETE FROM chunk WHERE segment_id = ?").run(segmentId);
}

/** Delete a message's segments (+ their chunks/vecs) and the message row. */
function purgeMessage(db: Database, messageId: string): void {
  const segIds = db
    .prepare("SELECT id FROM segment WHERE message_id = ?")
    .all(messageId) as { id: string }[];
  for (const { id } of segIds) purgeSegmentChunks(db, id);
  db.prepare("DELETE FROM segment WHERE message_id = ?").run(messageId);
  db.prepare("DELETE FROM message WHERE id = ?").run(messageId);
}

interface NewChunkRow {
  rowid: number;
  text: string;
}

function insertChunk(
  db: Database,
  chunk: Chunk,
  conversationId: string,
  messageId: string,
): NewChunkRow {
  const res = db
    .prepare(
      "INSERT INTO chunk (segment_id, conversation_id, message_id, sub, chunk_type, text, content_hash) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      chunk.segmentId,
      conversationId,
      messageId,
      chunk.sub,
      chunk.chunkType,
      chunk.text,
      chunk.contentHash,
    );
  return { rowid: Number(res.lastInsertRowid), text: chunk.text };
}

export async function ingestSource(
  source: ArchiveSource,
  opts: IngestOptions,
): Promise<IngestOutcome> {
  const db = openArchive(opts.dbPath, {});
  const logger: Logger = createLogger({
    prefix: "[acrag]",
    quiet: () => true,
    verbose: () => false,
  });
  const registry = buildDefaultRegistry();
  const ctx = { source };

  try {
    const resolved = registry.resolve(ctx);
    if (!resolved) {
      return { applied: false, reason: "no parser" };
    }

    let handles: ConversationHandle[] =
      resolved.adapter.parser.listConversations(ctx);
    if (opts.handleId) {
      handles = handles.filter((h) => h.id === opts.handleId);
      if (handles.length === 0) {
        return { applied: false, reason: `no conversation ${opts.handleId}` };
      }
    }

    let anyApplied = false;
    let lastConvId: string | undefined;
    let failed = 0;

    for (const handle of handles) {
      const convHash = fingerprintConversation(source, handle);
      const existing = lookupActiveConversation(db, handle.id);
      if (existing && convHash.length > 0 && existing.file_hash === convHash) {
        lastConvId = existing.id;
        continue; // idempotent no-op for this conversation
      }

      try {
        const result = registry.parseAndChunk(ctx, handle);
        if (!result) continue;
        const { transcript, chunks } = result;
        const conversationId = transcript.conversation.id;

        upsertConversation(
          db,
          transcript,
          handle.id,
          convHash,
          opts.parentConversationId,
        );
        replaceTags(db, transcript);

        // Map segmentId -> messageId so chunk rows carry denormalized FKs on the
        // fast path (the chunk_denorm_ai trigger then stays a no-op).
        const segToMessage = new Map<string, string>();
        for (const msg of transcript.messages) {
          for (const seg of msg.segments) segToMessage.set(seg.id, msg.id);
        }

        // Diff messages by (conversation_id, seq).
        const storedRows = db
          .prepare(
            "SELECT id, seq, content_hash FROM message WHERE conversation_id = ?",
          )
          .all(conversationId) as {
          id: string;
          seq: number;
          content_hash: string | null;
        }[];
        const storedBySeq = new Map<
          number,
          { id: string; hash: string | null }
        >();
        for (const r of storedRows)
          storedBySeq.set(r.seq, { id: r.id, hash: r.content_hash });

        const newSeqs = new Set<number>();
        const dirtyChunkRows: NewChunkRow[] = [];

        for (const msg of transcript.messages) {
          newSeqs.add(msg.seq);
          const content = segmentContentHash(msg.segments);
          const contentHash = messageContentHash(msg.segments);
          const stored = storedBySeq.get(msg.seq);
          if (stored && stored.hash === contentHash) {
            continue; // unchanged message -> no chunk changes, no re-embed
          }
          // new or changed: upsert message + segments, purge+reinsert chunks.
          upsertMessage(
            db,
            msg.id,
            conversationId,
            msg.seq,
            msg.role,
            content,
            contentHash,
            msg.createdAt ?? null,
            null,
            null,
          );
          for (const seg of msg.segments) upsertSegment(db, seg);
          const chunksBySeg = new Map<string, Chunk[]>();
          for (const c of chunks) {
            if (!segToMessage.has(c.segmentId)) continue;
            const arr = chunksBySeg.get(c.segmentId);
            if (arr) arr.push(c);
            else chunksBySeg.set(c.segmentId, [c]);
          }
          for (const seg of msg.segments) {
            purgeSegmentChunks(db, seg.id);
            for (const chunk of chunksBySeg.get(seg.id) ?? []) {
              const messageId =
                segToMessage.get(chunk.segmentId) ?? seg.messageId;
              dirtyChunkRows.push(
                insertChunk(db, chunk, conversationId, messageId),
              );
            }
          }
        }

        // Removed messages (present in DB, absent from new transcript).
        for (const r of storedRows) {
          if (!newSeqs.has(r.seq)) purgeMessage(db, r.id);
        }

        // Embed dirty chunks + vecInsert.
        if (dirtyChunkRows.length > 0) {
          const embed =
            opts.embedFn ??
            ((batch: string[]) =>
              embedBatch(batch, {
                host: opts.ollamaHost,
                model: opts.embedModel,
              }));
          const texts = dirtyChunkRows.map((c) => c.text);
          const vecs = await embedTexts(texts, {
            batchSize: EMBED_BATCH_SIZE,
            embed,
          });
          for (let i = 0; i < dirtyChunkRows.length; i++) {
            vecInsert(db, {
              table: "chunk_vec",
              keyColumn: "rowid",
              key: dirtyChunkRows[i].rowid,
              vec: vecs[i],
            });
          }
        }

        // Supersede: structural replace (new conversation id differs from old).
        if (existing && existing.id !== conversationId) {
          db.prepare(
            "UPDATE conversation SET superseded_by = ? WHERE id = ?",
          ).run(conversationId, existing.id);
        }

        anyApplied = true;
        lastConvId = conversationId;
      } catch (e) {
        // One bad conversation must never abort the whole sweep. Log and move on.
        failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(
          `[acrag] ingest: skipping conversation ${handle.id}: ${msg}\n`,
        );
      }
    }

    await runUpdaters(db, undefined as any, UPDATERS, logger);

    return { applied: anyApplied, conversationId: lastConvId, failed };
  } finally {
    db.close();
  }
}
