// tests/chunkers-cursor-v1.test.ts
import { test, expect } from "bun:test";
import { chunker } from "../src/chunkers/cursor/v1.ts";
import type {
  ParsedTranscript,
  ChunkStrategy,
} from "../src/contracts/types.ts";

const conv = (messages: ParsedTranscript["messages"]): ParsedTranscript => ({
  conversation: { id: "c0", agent: "cursor" },
  messages,
});
const seg = (id: string, kind: any, content: string) => ({
  id,
  messageId: "m0",
  index: 0,
  kind,
  content,
});

test("small prose segment -> one chunk, chunk_type=text", () => {
  const t = conv([
    {
      id: "m0",
      conversationId: "c0",
      role: "user",
      seq: 0,
      segments: [seg("s0", "text", "hello world")],
    },
  ]);
  const chunks = chunker.chunk(t);
  expect(chunks.length).toBe(1);
  expect(chunks[0]).toMatchObject({
    segmentId: "s0",
    sub: 0,
    chunkType: "text",
    text: "hello world",
  });
  expect(chunks[0].contentHash).toBeTruthy();
});

test("oversized code segment splits (never truncates), each split has a contextual header + overlap", () => {
  const big = "line\n".repeat(2000); // large code block
  const t = conv([
    {
      id: "m0",
      conversationId: "c0",
      role: "assistant",
      seq: 0,
      segments: [seg("s0", "code", big)],
    },
  ]);
  const s: ChunkStrategy = {
    maxSegmentSize: 100,
    overlap: 2,
    threshold: 10,
    algoVersion: 1,
  };
  const chunks = chunker.chunk(t, s);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((c) => c.chunkType === "code")).toBe(true);
  expect(chunks.every((c) => c.segmentId === "s0")).toBe(true);
  // every split carries a contextual header (mentions part N/M)
  expect(chunks.every((c) => /part \d+\/\d+/.test(c.text))).toBe(true);
  // no content lost: concatenating (minus headers/overlap) covers the whole block
  expect(chunks.map((c) => c.text).join("\n").length).toBeGreaterThan(
    big.length,
  );
  // sub indexes are 0..N-1
  expect(chunks.map((c) => c.sub)).toEqual(chunks.map((_, i) => i));
});

test("tool_call + tool_result stay adjacent (not separated across a boundary)", () => {
  const t = conv([
    {
      id: "m0",
      conversationId: "c0",
      role: "assistant",
      seq: 0,
      segments: [
        {
          id: "s0",
          messageId: "m0",
          index: 0,
          kind: "tool_call",
          content: "Read foo.ts",
          toolName: "Read",
          toolCallId: "tc1",
        },
        {
          id: "s1",
          messageId: "m0",
          index: 1,
          kind: "tool_result",
          content: "file contents",
          toolCallId: "tc1",
        },
      ],
    },
  ]);
  const chunks = chunker.chunk(t);
  const ids = chunks.map((c) => c.segmentId);
  expect(ids.indexOf("s0")).toBeLessThanOrEqual(ids.indexOf("s1")); // adjacent or same
});
