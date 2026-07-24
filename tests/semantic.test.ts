// tests/semantic.test.ts
// Semantic-retrieval e2e: ingest -> embed -> vec -> search -> relational join.
// Adapted: uses ingestSource (not the brief's ingestFile) with a FileSource, and a
// bag-of-chars embedFn (content-derived) so the query "center a div" is closest to the
// css chunk (whose char-bag is a superset of the query's). Cleanup uses node:fs unlinkSync.
import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { ingestSource } from "../src/ingest/ingester.ts";
import { openArchive } from "../src/archive/open.ts";
import { vecSearch } from "agent-archive-core";
import type { FileSource } from "../src/contracts/source.ts";

// Deterministic, content-derived embeddings: bag-of-chars into a 1024-dim vector.
// Each char contributes +1 to dimension (charCode % 1024); overlapping content
// -> overlapping dimensions -> smaller L2 distance.
const embedFn = async (batch: string[]) =>
  batch.map((t) => {
    const v = new Float32Array(1024);
    for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 1024] += 1;
    return v;
  });

const fileSource = (filePath: string, contents: string): FileSource => ({
  kind: "file",
  filePath,
  contents,
});

test("semantic search retrieves the matching conversation + thread reconstruction", async () => {
  const dbPath = `${import.meta.dir}/.tmp-sem.sqlite`;
  const a = `${import.meta.dir}/.tmp-a.jsonl`;
  const b = `${import.meta.dir}/.tmp-b.jsonl`;
  await Bun.write(
    a,
    JSON.stringify({ role: "user", content: "how to center a div in css" }) + "\n",
  );
  await Bun.write(
    b,
    JSON.stringify({ role: "user", content: "postgres connection pooling" }) + "\n",
  );
  const opts = {
    dbPath,
    ollamaHost: "http://x",
    embedModel: "bge-m3",
    embedFn,
  };
  await ingestSource(fileSource(a, await Bun.file(a).text()), opts);
  await ingestSource(fileSource(b, await Bun.file(b).text()), opts);

  const db = openArchive(dbPath, { readonly: true });
  try {
    const [q] = await embedFn(["center a div"]);
    const hits = vecSearch(db, {
      table: "chunk_vec",
      keyColumn: "rowid",
      vecColumn: "embedding",
      vec: q,
      limit: 3,
    });
    expect(hits.length).toBeGreaterThan(0);
    const topRowid = hits[0].key; // VecHit.key = the keyColumn value (chunk.rowid)
    const top = db
      .query(
        "SELECT conversation_id, message_id, chunk_type FROM chunk WHERE id = ?",
      )
      .get(topRowid) as any;
    // the top hit belongs to conversation A (the css one)
    const convA = db
      .query("SELECT source_path FROM conversation WHERE id = ?")
      .get(top.conversation_id) as any;
    expect(convA.source_path).toContain("tmp-a");

    // thread: all messages of that conversation, ordered by seq
    const thread = db
      .query(
        "SELECT seq, role FROM message WHERE conversation_id = ? ORDER BY seq",
      )
      .all(top.conversation_id) as any[];
    expect(thread.length).toBeGreaterThanOrEqual(1);
  } finally {
    db.close();
    for (const p of [dbPath, a, b]) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }
});
