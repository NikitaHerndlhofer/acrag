// tests/index.test.ts
// File-based sweep over a directory of .jsonl transcripts. Each file is a FileSource;
// ingestSource handles per-conversation hash-skip + supersede. Supersede requires a
// content-aware conversation id (changed content -> new id -> old superseded).
// Cleanup uses node:fs rmSync/unlinkSync (Bun.file().unlinkSync is not a function in Bun 1.3).
import { test, expect } from "bun:test";
import { rmSync, mkdirSync, unlinkSync } from "node:fs";
import { sweep } from "../src/ingest/scan.ts";
import { openArchive } from "../src/archive/open.ts";

test("sweep ingests new files, hash-skips unchanged, supersedes changed", async () => {
  const dbPath = `${import.meta.dir}/.tmp-sweep.sqlite`;
  const root = `${import.meta.dir}/.tmp-ws`;
  const fileA = `${root}/a.jsonl`;
  const fileB = `${root}/b.jsonl`;
  mkdirSync(root, { recursive: true });
  await Bun.write(fileA, JSON.stringify({ role: "user", content: "A" }) + "\n");
  await Bun.write(fileB, JSON.stringify({ role: "user", content: "B" }) + "\n");
  const embedFn = async (batch: string[]) =>
    batch.map(() => new Float32Array(1024).fill(0.5));
  const opts = {
    dbPath,
    ollamaHost: "http://x",
    embedModel: "bge-m3",
    embedFn,
  };

  await sweep({ root, opts }); // first pass: ingest both
  const db = openArchive(dbPath, { readonly: true });
  try {
    expect((db.query("SELECT COUNT(*) c FROM conversation").get() as any).c).toBe(2);
  } finally {
    db.close();
  }

  await sweep({ root, opts }); // second pass: hash-skip (no re-embed)
  await Bun.write(
    fileA,
    JSON.stringify({ role: "user", content: "A CHANGED" }) + "\n",
  );
  await sweep({ root, opts }); // third pass: fileA changed -> supersede + re-ingest
  const db2 = openArchive(dbPath, { readonly: true });
  try {
    const superseded = (
      db2
        .query(
          "SELECT COUNT(*) c FROM conversation WHERE superseded_by IS NOT NULL",
        )
        .get() as any
    ).c;
    expect(superseded).toBeGreaterThanOrEqual(1);
    expect(
      (
        db2
          .query("SELECT COUNT(*) c FROM conversation WHERE superseded_by IS NULL")
          .get() as any
      ).c,
    ).toBe(2);
  } finally {
    db2.close();
    try {
      rmSync(root, { recursive: true });
    } catch {}
    try {
      unlinkSync(dbPath);
    } catch {}
  }
});
