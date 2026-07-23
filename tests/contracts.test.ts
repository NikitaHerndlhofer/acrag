import { test, expect } from "bun:test";
import type {
  Segment,
  ParsedMessage,
  ParsedTranscript,
  Chunk,
  ChunkStrategy,
  AgentId,
  SegmentKind,
  MessageRole,
} from "../src/contracts/types.ts";
import type {
  ArchiveSource,
  FileSource,
  SqliteSource,
  ConversationHandle,
} from "../src/contracts/source.ts";
import type { DetectContext, Parser } from "../src/contracts/parser.ts";
import type { AgentRegistry } from "../src/contracts/registry.ts";

test("Segment/ParsedMessage/ParsedTranscript shapes", () => {
  const seg: Segment = {
    id: "s0",
    messageId: "m0",
    index: 0,
    kind: "text",
    content: "hi",
  };
  const msg: ParsedMessage = {
    id: "m0",
    conversationId: "c0",
    role: "user",
    seq: 0,
    segments: [seg],
    createdAt: "2026-01-01T00:00:00Z",
  };
  const t: ParsedTranscript = {
    conversation: {
      id: "c0",
      agent: "cursor",
      agentVersion: "1.2",
      repository: "acrag",
      tags: ["background"],
    },
    messages: [msg],
  };
  expect(t.messages[0].segments[0].id).toBe("s0");
});

test("Chunk shape (segmentId-keyed, no denormalized ids on the type)", () => {
  const c: Chunk = {
    segmentId: "s0",
    sub: 0,
    chunkType: "text",
    text: "hi",
    contentHash: "deadbeef",
  };
  expect(
    (c as unknown as Record<string, unknown>).conversationId,
  ).toBeUndefined();
  expect((c as unknown as Record<string, unknown>).messageId).toBeUndefined();
});

test("ChunkStrategy base fields", () => {
  const s: ChunkStrategy = {
    maxSegmentSize: 512,
    overlap: 2,
    threshold: 512,
    algoVersion: 1,
  };
  expect(s.algoVersion).toBe(1);
});

test("AgentId / SegmentKind / MessageRole unions are string literals", () => {
  const a: AgentId = "cursor";
  const k: SegmentKind = "tool_call";
  const r: MessageRole = "tool";
  expect([a, k, r]).toEqual(["cursor", "tool_call", "tool"]);
});

test("ArchiveSource is FileSource | SqliteSource; ConversationHandle carries id + meta", () => {
  const file: FileSource = { kind: "file", filePath: "/x/a.jsonl", contents: "{}" };
  const sqlite: SqliteSource = { kind: "sqlite", dbPath: "/x/state.vscdb" };
  const src: ArchiveSource = Math.random() > 0.5 ? file : sqlite;
  expect(["file", "sqlite"]).toContain(src.kind);

  const h: ConversationHandle = { id: "00096f9a-...", meta: { lastUpdatedAt: 1783535488786 } };
  expect(h.id).toBeTruthy();
  expect(h.meta?.lastUpdatedAt).toBe(1783535488786);
});

test("DetectContext takes a source (not filePath/contents); Parser is per-conversation", () => {
  const ctx: DetectContext = { source: { kind: "sqlite", dbPath: "/x/state.vscdb" } };
  // DetectContext must NOT carry filePath/contents anymore (source replaces them)
  expect((ctx as unknown as Record<string, unknown>).filePath).toBeUndefined();
  expect((ctx as unknown as Record<string, unknown>).contents).toBeUndefined();

  // Compile-time signature check (erased at runtime): Parser now has listConversations + parse(handle),
  // and AgentRegistry.parseAndChunk takes a ConversationHandle. If these drift, tsc fails this file.
  const _p: Parser = {
    agent: "cursor",
    versionRange: "^1",
    id: "cursor:v1",
    detect: () => null,
    listConversations: () => [],
    parse: () => ({ conversation: { id: "c0", agent: "cursor" }, messages: [] }),
  };
  const _r: AgentRegistry = {
    register: () => {},
    resolve: () => null,
    parseAndChunk: () => null,
  };
  expect(_p.id).toBe("cursor:v1");
  expect(typeof _r.parseAndChunk).toBe("function");
});
