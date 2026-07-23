import { test, expect } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { openArchive } from "../src/archive/open.ts";

test("openArchive creates the archive DB at the resolved path", () => {
  const path = `${import.meta.dir}/.tmp-skeleton.sqlite`;
  const db = openArchive(path, {});
  try {
    expect(db.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
  } finally {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  }
});
