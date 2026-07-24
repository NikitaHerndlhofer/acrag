/**
 * `acrag ingest-cursor <conversation_id>` — targeted re-ingest of ONE Cursor
 * conversation from the live `state.vscdb`.
 *
 * The Cursor `stop`/`subagentStop` hooks carry a `conversation_id`; rather than
 * re-sweeping the whole 20 GB DB on every turn, the hook dispatcher spawns this
 * command with that id. `ingestSource` filters to the single matching composer
 * and ingests it idempotently (per-composer `lastUpdatedAt` skip + per-seq diff,
 * so only new turns get embedded).
 */
import { existsSync } from "node:fs";
import { ingestSource } from "../ingest/ingester.ts";
import type { IngestOptions } from "../ingest/types.ts";
import type { ResolvedPaths } from "../paths.ts";
import { error } from "../log.ts";

export async function runIngestCursor(
  conversationId: string,
  paths: ResolvedPaths,
): Promise<void> {
  if (!paths.cursorDb) {
    error("ingest-cursor: no Cursor DB configured (set ACRAG_CURSOR_DB).");
    process.exit(2);
  }
  if (!existsSync(paths.cursorDb)) {
    error(`ingest-cursor: Cursor DB not found at ${paths.cursorDb}.`);
    process.exit(2);
  }
  const opts: IngestOptions = {
    dbPath: paths.archive,
    ollamaHost: paths.ollamaHost,
    embedModel: paths.embedModel,
    handleId: conversationId,
  };
  const out = await ingestSource(
    { kind: "sqlite", dbPath: paths.cursorDb },
    opts,
  );
  if (!out.applied) {
    error(`ingest-cursor: ${conversationId} — ${out.reason ?? "unchanged"}`);
  }
}
