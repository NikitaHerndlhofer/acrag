import { test, expect } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { openArchive } from "../src/archive/open.ts";
import { LATEST_VERSION, MIGRATIONS } from "../src/archive/migrations.ts";

test("001_init lands at LATEST_VERSION with all tables", () => {
  const path = `${import.meta.dir}/.tmp-mig.sqlite`;
  const db = openArchive(path, {});
  try {
    expect(db.query("PRAGMA user_version").get()).toEqual({
      user_version: LATEST_VERSION,
    });
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    for (const t of [
      "conversation",
      "conversation_tag",
      "message",
      "segment",
      "chunk",
      "chunk_fts",
      "chunk_trigram",
      "chunk_vec",
    ]) {
      expect(names.has(t), `missing table ${t}`).toBe(true);
    }
    // denorm trigger exists
    const trigs = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='chunk_denorm_ai'",
      )
      .all();
    expect(trigs.length).toBe(1);
  } finally {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  }
});

test("MIGRATIONS entries have frozen sha256 (drift canary)", () => {
  const { createHash } = require("node:crypto");
  const FROZEN: Record<number, string> = {
    1: "506904c8ccf29d690d25df1bb9c5432fab1146d99e92f69490018b17ce7d4478",
  };
  for (const m of MIGRATIONS) {
    const expected = FROZEN[m.version];
    if (!expected)
      throw new Error(
        `migration ${m.version} (${m.name}) has no FROZEN hash — compute its sha256 and add it`,
      );
    expect(createHash("sha256").update(m.sql).digest("hex")).toBe(expected);
  }
});
