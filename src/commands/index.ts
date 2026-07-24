/**
 * `acrag index` (Task 10) — the CLI wrapper around `sweep`.
 *
 * Resolves the transcript root from env/DEFAULTS (`ACRAG_TRANSCRIPTS_DIR` →
 * `~/.acrag/transcripts`) and runs the file-based sweep: hash-skip unchanged
 * `.jsonl` files, ingest new ones, supersede changed ones. The heavy lifting
 * (per-conversation hash-skip + supersede) lives in `ingestSource`; this
 * command only resolves the root and forwards `--limit` if given.
 */
import { sweep } from "../ingest/scan.ts";
import type { IngestOptions } from "../ingest/types.ts";
import type { ResolvedPaths } from "../paths.ts";

export interface RunIndexArgs {
  paths: ResolvedPaths;
  /** Optional cap on the number of files processed. */
  limit?: number;
}

export async function runIndex({ paths, limit }: RunIndexArgs): Promise<void> {
  const opts: IngestOptions = {
    dbPath: paths.archive,
    ollamaHost: paths.ollamaHost,
    embedModel: paths.embedModel,
  };
  const out = await sweep({ root: paths.transcriptsDir, opts, limit });
  process.stdout.write(
    `index: scanned ${out.scanned}, applied ${out.applied}\n`,
  );
}
