// tests/parsers-cursor-v1.test.ts
import { test, expect } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { ensureExtensionCapableSqlite } from "../src/archive/open.ts";
import { parser } from "../src/parsers/cursor/v1.ts";
import type { DetectContext } from "../src/contracts/parser.ts";

// Must run before any `new Database` in this file (Bun locks the process SQLite).
ensureExtensionCapableSqlite();

const fixturePath = join(import.meta.dir, "fixtures/cursor/v1-sample.vscdb");
const ctx: DetectContext = { source: { kind: "sqlite", dbPath: fixturePath } };

test("detect claims the Cursor fixture with a version", () => {
  const m = parser.detect(ctx);
  expect(m).not.toBeNull();
  expect(m!.agent).toBe("cursor");
  expect(typeof m!.version).toBe("string");
});

test("listConversations enumerates the fixture's composer(s)", () => {
  const handles = parser.listConversations(ctx);
  expect(handles.length).toBeGreaterThan(0);
  for (const h of handles) expect(typeof h.id).toBe("string");
});

test("parse(handle) emits typed segments + conversation metadata", () => {
  const t = parser.parse(ctx, parser.listConversations(ctx)[0]);
  expect(t.conversation.agent).toBe("cursor");
  expect(t.conversation.id).toBeTruthy();
  expect(t.messages.length).toBeGreaterThan(0);
  for (const m of t.messages) {
    expect(typeof m.id).toBe("string");
    expect(["user", "assistant", "system", "tool"]).toContain(m.role);
    expect(m.segments.length).toBeGreaterThan(0);
    for (const s of m.segments) expect(s.content.length).toBeGreaterThan(0);
  }
  // the fixture includes a tool_call + tool_result pair linked by tool_call_id
  const calls = t.messages.flatMap((m) => m.segments).filter((s) => s.kind === "tool_call");
  const results = t.messages.flatMap((m) => m.segments).filter((s) => s.kind === "tool_result");
  expect(calls.length).toBeGreaterThan(0);
  expect(results.length).toBeGreaterThan(0);
  expect(results.every((r) => r.toolCallId)).toBe(true);
});

test("parse is fail-soft on a malformed bubble row", () => {
  const tmp = `${import.meta.dir}/.tmp-cursor-v1-malformed.vscdb`;
  copyFileSync(fixturePath, tmp);
  try {
    const db = new Database(tmp);
    // Bun 1.3.14 typings require bindings as a single array (not variadic args).
    db.run("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)", [
      "bubbleId:bad:not-json",
      Buffer.from("{ this is not valid json }", "utf8"),
    ]);
    db.close();
    const badCtx: DetectContext = { source: { kind: "sqlite", dbPath: tmp } };
    const t = parser.parse(badCtx, parser.listConversations(badCtx)[0]);
    expect(t.messages.length).toBeGreaterThan(0); // did not abort the whole conversation
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
});
