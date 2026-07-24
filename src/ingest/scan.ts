/**
 * The sweep (Task 10) — `acrag index` over a directory of `.jsonl` transcripts.
 *
 * `sweep({ root, opts, limit? })` walks `root` recursively for `*.jsonl` files,
 * builds a `FileSource` per file, and calls `ingestSource` — which handles the
 * per-conversation hash-skip + supersede internally (Task 8). The sweep itself
 * only enumerates files; idempotency lives in the ingester. `--limit N` caps
 * the number of files processed (incremental backfill).
 *
 * Cross-source dedup (sqlite wins): a Cursor on-disk transcript's filename IS
 * the same UUID the sqlite parser uses as `composerId` in `state.vscdb`. Both
 * sources therefore produce the SAME conversation id but DIFFERENT `file_hash`
 * schemes (`lu:<ts>` for sqlite, `sha256(contents)` for file), so the ingester's
 * hash-skip can't reconcile them and would re-embed forever. To break that, the
 * sweep skips a UUID-named JSONL file whose conversation already exists in the
 * archive with a sqlite-sourced hash (`lu:`) — `state.vscdb` is authoritative
 * for any chat it contains. JSONL-only conversations (absent from state.vscdb)
 * fall through to the ingester, whose sha256 hash-skip keeps them idempotent.
 */
import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import type { FileSource } from "../contracts/source.ts";
import { ingestSource } from "./ingester.ts";
import type { IngestOptions, IngestOutcome } from "./types.ts";
import { existsSync } from "node:fs";
import { openArchive } from "../archive/open.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** Number of UUID-named files skipped because sqlite already indexes them. */
  skippedSqliteOwned: number;
  /** Per-file outcomes, in scan order. */
  results: IngestOutcome[];
}

/** Recursively collect `.jsonl` files under `root`, sorted for determinism. */
async function listJsonlFiles(root: string): Promise<string[]> {
  // A fresh install has no transcripts dir yet — treat that as "nothing to
  // ingest" rather than letting Bun.Glob throw ENOENT on a missing cwd.
  if (!existsSync(root)) return [];
  const glob = new Bun.Glob("**/*.jsonl");
  const found: string[] = [];
  for await (const rel of glob.scan({
    cwd: root,
    absolute: true,
    dot: false,
  })) {
    found.push(rel);
  }
  found.sort();
  return found;
}

/**
 * Active conversation id → file_hash, for the cross-source dedup guard. Returns
 * an empty map if the archive doesn't exist yet (fresh install) or can't be
 * read — in that case nothing is sqlite-owned, so every file falls through.
 *
 * Opens via `openArchive` (not a raw `new Database`) so the sqlite-vec dylib is
 * loaded: the archive holds a `chunk_vec` vec0 virtual table, and a plain RO
 * open throws on that table → empty map → no dedup. `openArchive` loads the
 * extension and reads cleanly in readonly mode.
 */
function activeConversationHashes(dbPath: string): Map<string, string> {
  if (!dbPath || !existsSync(dbPath)) return new Map();
  let db: Database;
  try {
    db = openArchive(dbPath, { readonly: true });
  } catch {
    return new Map();
  }
  try {
    const rows = db
      .prepare(
        "SELECT id, file_hash FROM conversation WHERE superseded_by IS NULL",
      )
      .all() as Array<{ id: string; file_hash: string | null }>;
    const m = new Map<string, string>();
    for (const r of rows) if (r.file_hash) m.set(r.id, r.file_hash);
    return m;
  } finally {
    db.close();
  }
}

function conversationIdFromPath(filePath: string): string | undefined {
  const base = basename(filePath).replace(/\.jsonl$/i, "");
  return UUID.test(base) ? base : undefined;
}

export async function sweep({
  root,
  opts,
  limit,
}: SweepOptions): Promise<SweepOutcome> {
  const files = await listJsonlFiles(root);
  const capped =
    typeof limit === "number" ? files.slice(0, Math.max(0, limit)) : files;

  const owned = activeConversationHashes(opts.dbPath);

  const results: IngestOutcome[] = [];
  let applied = 0;
  let skippedSqliteOwned = 0;

  for (const filePath of capped) {
    const id = conversationIdFromPath(filePath);
    const existingHash = id ? owned.get(id) : undefined;
    if (existingHash && existingHash.startsWith("lu:")) {
      skippedSqliteOwned += 1; // state.vscdb owns this chat — skip the JSONL copy
      continue;
    }

    const contents = await Bun.file(filePath).text();
    const source: FileSource = { kind: "file", filePath, contents };
    const out = await ingestSource(source, opts);
    results.push(out);
    if (out.applied) applied += 1;
  }

  return {
    scanned: capped.length,
    applied,
    skippedSqliteOwned,
    results,
  };
}
