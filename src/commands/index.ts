/**
 * `acrag index` — index Cursor chats.
 *
 * Primary source: the live Cursor `state.vscdb` (SqliteSource). If
 * `paths.cursorDb` resolves to an existing file, enumerate every composer and
 * ingest it idempotently (per-composer `lastUpdatedAt` skip). Secondary sources
 * (both swept only if they exist):
 *   - `paths.cursorTranscriptsDir` — on-disk Cursor agent transcripts
 *     (`…/agent-transcripts/<id>/<id>.jsonl`). The sweep's sqlite-wins guard
 *     skips any UUID-named file whose conversation state.vscdb already owns, so
 *     this backfills chats that exist ONLY on disk (e.g. legacy/pruned from db).
 *   - `paths.transcriptsDir` — generic `*.jsonl` for non-Cursor agents or manual
 *     transcripts.
 * `--limit N` caps each file sweep (incremental backfill); the DB sweep is
 * always full but idempotent.
 */
import { existsSync } from "node:fs";
import { sweep } from "../ingest/scan.ts";
import { ingestSource } from "../ingest/ingester.ts";
import type { IngestOptions } from "../ingest/types.ts";
import type { ResolvedPaths } from "../paths.ts";

export interface RunIndexArgs {
  paths: ResolvedPaths;
  /** Optional cap on the number of *file* sweeps processed. */
  limit?: number;
}

export async function runIndex({ paths, limit }: RunIndexArgs): Promise<void> {
  const opts: IngestOptions = {
    dbPath: paths.archive,
    ollamaHost: paths.ollamaHost,
    embedModel: paths.embedModel,
  };

  let dbApplied = false;
  if (paths.cursorDb && existsSync(paths.cursorDb)) {
    const out = await ingestSource(
      { kind: "sqlite", dbPath: paths.cursorDb },
      opts,
    );
    dbApplied = out.applied;
    process.stdout.write(
      `index: cursor db ${paths.cursorDb} (${out.applied ? "updated" : "unchanged"})${out.failed ? `, failed ${out.failed}` : ""}\n`,
    );
  }

  let cursorJsonlApplied = 0;
  if (paths.cursorTranscriptsDir && existsSync(paths.cursorTranscriptsDir)) {
    const out = await sweep({ root: paths.cursorTranscriptsDir, opts, limit });
    cursorJsonlApplied = out.applied;
    process.stdout.write(
      `index: cursor transcripts scanned ${out.scanned}, applied ${out.applied}, skipped (sqlite-owned) ${out.skippedSqliteOwned}\n`,
    );
  }

  let fileScanned = 0;
  let fileApplied = 0;
  if (existsSync(paths.transcriptsDir)) {
    const out = await sweep({ root: paths.transcriptsDir, opts, limit });
    fileScanned = out.scanned;
    fileApplied = out.applied;
    process.stdout.write(
      `index: transcripts scanned ${fileScanned}, applied ${fileApplied}\n`,
    );
  }

  if (!dbApplied && cursorJsonlApplied === 0 && fileApplied === 0) {
    process.stdout.write("index: nothing to do\n");
  }
}
