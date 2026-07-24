/**
 * The sweep (Task 10) — `acrag index` over a directory of `.jsonl` transcripts.
 *
 * `sweep({ root, opts, limit? })` walks `root` recursively for `*.jsonl` files,
 * builds a `FileSource` per file, and calls `ingestSource` — which handles the
 * per-conversation hash-skip + supersede internally (Task 8). The sweep itself
 * only enumerates files; idempotency lives in the ingester. `--limit N` caps
 * the number of files processed (incremental backfill).
 */
import type { FileSource } from "../contracts/source.ts";
import { ingestSource } from "./ingester.ts";
import type { IngestOptions, IngestOutcome } from "./types.ts";

export interface SweepOptions {
  /** Directory to scan recursively for `.jsonl` transcripts. */
  root: string;
  /** Ingest options (archive path, embedder, …). */
  opts: IngestOptions;
  /** Optional cap on the number of files processed. */
  limit?: number;
}

export interface SweepOutcome {
  /** Number of `.jsonl` files discovered. */
  scanned: number;
  /** Number of files for which `ingestSource` reported `applied: true`. */
  applied: number;
  /** Per-file outcomes, in scan order. */
  results: IngestOutcome[];
}

/** Recursively collect `.jsonl` files under `root`, sorted for determinism. */
async function listJsonlFiles(root: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.jsonl");
  const found: string[] = [];
  for await (const rel of glob.scan({ cwd: root, absolute: true, dot: false })) {
    found.push(rel);
  }
  found.sort();
  return found;
}

export async function sweep({ root, opts, limit }: SweepOptions): Promise<SweepOutcome> {
  const files = await listJsonlFiles(root);
  const capped = typeof limit === "number" ? files.slice(0, Math.max(0, limit)) : files;

  const results: IngestOutcome[] = [];
  let applied = 0;

  for (const filePath of capped) {
    const contents = await Bun.file(filePath).text();
    const source: FileSource = { kind: "file", filePath, contents };
    const out = await ingestSource(source, opts);
    results.push(out);
    if (out.applied) applied += 1;
  }

  return { scanned: capped.length, applied, results };
}
