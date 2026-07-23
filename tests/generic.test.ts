// tests/generic.test.ts
import { test, expect } from "bun:test";
import { parser } from "../src/parsers/generic.ts";
import { chunker } from "../src/chunkers/generic.ts";
import type { DetectContext } from "../src/contracts/parser.ts";

test("generic parser extracts role/content from arbitrary JSONL, never aborts", () => {
  const contents = [
    { role: "user", content: "what is 2+2" },
    "{ malformed line }",
    { role: "assistant", text: "4", kind: "text" },
  ]
    .map((o) => (typeof o === "string" ? o : JSON.stringify(o)))
    .join("\n");
  const ctx: DetectContext = { source: { kind: "file", filePath: "x.jsonl", contents } };
  const handle = parser.listConversations(ctx)[0];
  const t = parser.parse(ctx, handle);
  expect(t.messages.length).toBe(2); // skipped the malformed line
  expect(t.messages[0].role).toBe("user");
});

test("generic chunker treats all segments as text and chunks prose by sentence", () => {
  const t = {
    conversation: { id: "c0", agent: "cursor" },
    messages: [
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
            kind: "code",
            content: "x = 1",
          },
        ],
      },
    ],
  } as any;
  const chunks = chunker.chunk(t);
  expect(chunks[0].chunkType).toBe("text"); // coerced to text
});
