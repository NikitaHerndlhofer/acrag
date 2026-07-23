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
