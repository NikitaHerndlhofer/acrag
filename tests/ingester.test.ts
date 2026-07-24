// tests/ingester.test.ts
// Adapted for the ArchiveSource model: the ingester is `ingestSource(source, opts)`.
// For a FileSource the caller provides `contents`; file_hash = sha256(contents).
// Cleanup uses unlinkSync from node:fs (Bun.file().unlinkSync is not a function in Bun 1.3).
import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { ingestSource } from "../src/ingest/ingester.ts";
import { openArchive } from "../src/archive/open.ts";
import { ensureExtensionCapableSqlite } from "../src/archive/open.ts";
import type { FileSource, SqliteSource } from "../src/contracts/source.ts";

// Must run before any `new Database` in this file (Bun locks the process SQLite).
ensureExtensionCapableSqlite();

const cursorFixture = join(import.meta.dir, "fixtures/cursor/v1-sample.vscdb");

const mkOpts = (embedFn: any) => ({
  embedFn,
  ollamaHost: "http://x",
  embedModel: "bge-m3",
});

const writeTranscript = (path: string, body: string) => Bun.write(path, body);
const readSrc = (path: string) => Bun.file(path).text();
const cleanup = (paths: string[]) => {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {}
  }
};
const fileSource = (filePath: string, contents: string): FileSource => ({
  kind: "file",
  filePath,
  contents,
});

const sqliteSource = (dbPath: string): SqliteSource => ({
  kind: "sqlite",
  dbPath,
});

test("first ingest creates conversation + messages + segments + chunks + vec rows", async () => {
  const dbPath = `${import.meta.dir}/.tmp-ingest.sqlite`;
  const src = `${import.meta.dir}/.tmp-src.jsonl`;
  writeTranscript(
    src,
    JSON.stringify({ role: "user", content: "hello" }) +
      "\n" +
      JSON.stringify({ role: "assistant", content: "hi there" }) +
      "\n",
  );
  const embedFn = async (batch: string[]) =>
    batch.map(() => new Float32Array(1024).fill(0.1));
  const contents = await readSrc(src);
  const out = await ingestSource(fileSource(src, contents), {
    ...mkOpts(embedFn),
    dbPath,
  });
  expect(out.applied).toBe(true);
  const db = openArchive(dbPath, { readonly: true });
  try {
    expect((db.query("SELECT COUNT(*) c FROM conversation").get() as any).c).toBe(1);
    expect((db.query("SELECT COUNT(*) c FROM message").get() as any).c).toBe(2);
    expect((db.query("SELECT COUNT(*) c FROM chunk").get() as any).c).toBeGreaterThan(0);
    expect((db.query("SELECT COUNT(*) c FROM chunk_vec").get() as any).c).toBeGreaterThan(0);
    const row = db
      .query("SELECT conversation_id, message_id FROM chunk LIMIT 1")
      .get() as any;
    expect(row.conversation_id).toBeTruthy();
    expect(row.message_id).toBeTruthy();
  } finally {
    db.close();
    cleanup([dbPath, src]);
  }
});

test("re-ingest with unchanged source hash is a no-op", async () => {
  const dbPath = `${import.meta.dir}/.tmp-noop.sqlite`;
  const src = `${import.meta.dir}/.tmp-src2.jsonl`;
  writeTranscript(src, JSON.stringify({ role: "user", content: "hi" }) + "\n");
  let calls = 0;
  const embedFn = async (batch: string[]) => {
    calls += batch.length;
    return batch.map(() => new Float32Array(1024));
  };
  const contents = await readSrc(src);
  await ingestSource(fileSource(src, contents), { ...mkOpts(embedFn), dbPath });
  const firstCalls = calls;
  const out = await ingestSource(fileSource(src, contents), {
    ...mkOpts(embedFn),
    dbPath,
  });
  expect(out.applied).toBe(false);
  expect(calls).toBe(firstCalls);
  cleanup([dbPath, src]);
});

test("changed turn -> re-chunk + re-embed; old chunk_vec entries removed", async () => {
  const dbPath = `${import.meta.dir}/.tmp-chg.sqlite`;
  const src = `${import.meta.dir}/.tmp-src3.jsonl`;
  writeTranscript(src, JSON.stringify({ role: "user", content: "v1" }) + "\n");
  const embedFn = async (batch: string[]) =>
    batch.map((_, i) => new Float32Array(1024).fill(i + 1));
  await ingestSource(fileSource(src, await readSrc(src)), {
    ...mkOpts(embedFn),
    dbPath,
  });
  writeTranscript(
    src,
    JSON.stringify({ role: "user", content: "v2 different" }) + "\n",
  );
  await ingestSource(fileSource(src, await readSrc(src)), {
    ...mkOpts(embedFn),
    dbPath,
  });
  const db = openArchive(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT content_hash FROM chunk").all() as any[];
    expect(rows.every((r) => r.content_hash)).toBe(true);
    expect((db.query("SELECT COUNT(*) c FROM chunk_vec").get() as any).c).toBe(
      rows.length,
    );
  } finally {
    db.close();
    cleanup([dbPath, src]);
  }
});

// --- SqliteSource (Cursor state.vscdb) ingest ---

test("sqlite ingest: indexes the fixture's conversations + chunks + vec rows", async () => {
  const dbPath = `${import.meta.dir}/.tmp-sqlite.sqlite`;
  const embedFn = async (batch: string[]) =>
    batch.map(() => new Float32Array(1024).fill(0.7));
  const out = await ingestSource(sqliteSource(cursorFixture), {
    ...mkOpts(embedFn),
    dbPath,
  });
  expect(out.applied).toBe(true);
  const db = openArchive(dbPath, { readonly: true });
  try {
    expect((db.query("SELECT COUNT(*) c FROM conversation").get() as any).c).toBeGreaterThan(0);
    expect((db.query("SELECT COUNT(*) c FROM message").get() as any).c).toBeGreaterThan(0);
    expect((db.query("SELECT COUNT(*) c FROM chunk").get() as any).c).toBeGreaterThan(0);
    expect((db.query("SELECT COUNT(*) c FROM chunk_vec").get() as any).c).toBeGreaterThan(0);
    // conversations ingested from Cursor carry agent_name = 'cursor'
    const agent = (
      db.query("SELECT agent_name FROM conversation LIMIT 1").get() as any
    ).agent_name;
    expect(agent).toBe("cursor");
  } finally {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {}
  }
});

test("sqlite re-ingest is a no-op when lastUpdatedAt is unchanged", async () => {
  const dbPath = `${import.meta.dir}/.tmp-sqlite-noop.sqlite`;
  let calls = 0;
  const embedFn = async (batch: string[]) => {
    calls += batch.length;
    return batch.map(() => new Float32Array(1024));
  };
  await ingestSource(sqliteSource(cursorFixture), {
    ...mkOpts(embedFn),
    dbPath,
  });
  const firstCalls = calls;
  const out = await ingestSource(sqliteSource(cursorFixture), {
    ...mkOpts(embedFn),
    dbPath,
  });
  expect(out.applied).toBe(false);
  expect(calls).toBe(firstCalls);
  try {
    unlinkSync(dbPath);
  } catch {}
});

test("sqlite targeted ingest (handleId) ingests only that conversation", async () => {
  const dbPath = `${import.meta.dir}/.tmp-sqlite-targeted.sqlite`;
  const embedFn = async (batch: string[]) =>
    batch.map(() => new Float32Array(1024).fill(0.3));
  // First, full ingest.
  await ingestSource(sqliteSource(cursorFixture), {
    ...mkOpts(embedFn),
    dbPath,
  });
  const db = openArchive(dbPath, { readonly: true });
  let total: number;
  let firstId: string;
  try {
    total = (db.query("SELECT COUNT(*) c FROM conversation").get() as any).c;
    firstId = (db.query("SELECT id FROM conversation LIMIT 1").get() as any).id;
  } finally {
    db.close();
  }
  expect(total).toBeGreaterThan(0);
  // Targeted re-ingest of one conversation: applied=false (unchanged), no new rows.
  const out = await ingestSource(sqliteSource(cursorFixture), {
    ...mkOpts(embedFn),
    dbPath,
    handleId: firstId,
  });
  expect(out.applied).toBe(false);
  const db2 = openArchive(dbPath, { readonly: true });
  try {
    const after = (db2.query("SELECT COUNT(*) c FROM conversation").get() as any).c;
    expect(after).toBe(total);
  } finally {
    db2.close();
    try {
      unlinkSync(dbPath);
    } catch {}
  }
});
