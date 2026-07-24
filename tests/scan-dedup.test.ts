// tests/scan-dedup.test.ts
// The sweep's sqlite-wins guard: a UUID-named JSONL file whose conversation
// state.vscdb already owns (file_hash `lu:<ts>`) is skipped, so the on-disk
// copy never re-embeds over the live sqlite row. JSONL-only files still ingest.
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sweep } from "../src/ingest/scan.ts";
import { openArchive, ensureExtensionCapableSqlite } from "../src/archive/open.ts";

ensureExtensionCapableSqlite();

const OWNED = "f4870b77-86dd-4010-9964-162b8d72fbc1"; // sqlite already has this
const JSONL_ONLY = "a9876901-71db-43e9-b3bb-3b19e6c0c330"; // only on disk

const transcript = (id: string) =>
  [
    { role: "user", message: { content: [{ type: "text", text: `hello ${id}` }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n") + "\n";

test("sweep skips UUID files sqlite already owns, ingests JSONL-only files", async () => {
  const dbPath = `${import.meta.dir}/.tmp-dedup.sqlite`;
  const root = `${import.meta.dir}/.tmp-dedup-dir`;
  // Idempotent setup: clear any stale artifacts from a prior failed run.
  try { unlinkSync(dbPath); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${OWNED}.jsonl`), transcript(OWNED));
  writeFileSync(join(root, `${JSONL_ONLY}.jsonl`), transcript(JSONL_ONLY));

  // Pre-seed the archive as if the sqlite sweep had already indexed OWNED.
  const seed = openArchive(dbPath, {});
  seed
    .prepare(
      "INSERT INTO conversation (id, agent_name, source_path, file_hash) VALUES (?, ?, ?, ?)",
    )
    .run(OWNED, "cursor", OWNED, "lu:1784861293285");
  seed.close();

  const embedFn = async (batch: string[]) =>
    batch.map(() => new Float32Array(1024).fill(0.1));
  const out = await sweep({
    root,
    opts: {
      dbPath,
      ollamaHost: "http://x",
      embedModel: "bge-m3",
      embedFn,
    },
  });

  expect(out.scanned).toBe(2);
  expect(out.skippedSqliteOwned).toBe(1);
  expect(out.applied).toBe(1); // only the JSONL-only file

  // sqlite-owned row is untouched (still `lu:`, not overwritten with a sha256).
  const db = openArchive(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT id, file_hash FROM conversation ORDER BY id")
      .all() as Array<{ id: string; file_hash: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r.file_hash]));
    expect(byId.get(OWNED)).toBe("lu:1784861293285");
    expect(byId.get(JSONL_ONLY)?.startsWith("lu:")).toBe(false); // file-sourced sha256
    expect(
      (db.prepare("SELECT COUNT(*) c FROM conversation").get() as any).c,
    ).toBe(2);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
    unlinkSync(dbPath);
  }
});
