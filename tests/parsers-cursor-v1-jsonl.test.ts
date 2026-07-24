// tests/parsers-cursor-v1-jsonl.test.ts
import { test, expect } from "bun:test";
import { parser } from "../src/parsers/cursor/v1-jsonl.ts";
import type { DetectContext } from "../src/contracts/parser.ts";

const UUID = "f4870b77-86dd-4010-9964-162b8d72fbc1";
const PARENT = "49b08d69-f0c5-451c-b0e8-1707cc159a7f";
const WS = `/home/u/.cursor/projects/Users-u-Documents-myrepo/agent-transcripts/${UUID}/${UUID}.jsonl`;
const SUB = `/home/u/.cursor/projects/Users-u-Documents-myrepo/agent-transcripts/${PARENT}/subagents/${UUID}.jsonl`;

function ctx(filePath: string, contents: string): DetectContext {
  return { source: { kind: "file", filePath, contents } };
}

const SAMPLE = [
  { role: "user", message: { content: [{ type: "text", text: "hello world" }] } },
  {
    role: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "hi" },
        { type: "tool_use", id: "call_1", name: "ReadFile", input: { path: "/x" } },
      ],
    },
  },
  {
    role: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "text", text: "file contents" }],
        },
      ],
    },
  },
  "{ not valid json }",
  { role: "assistant", message: { content: "plain string content" } },
]
  .map((o) => (typeof o === "string" ? o : JSON.stringify(o)))
  .join("\n");

test("detect claims a UUID-named Cursor transcript file", () => {
  expect(parser.detect(ctx(UUID + ".jsonl", SAMPLE))).not.toBeNull();
});

test("detect rejects non-UUID filenames or non-transcript shapes", () => {
  expect(parser.detect(ctx("notes.jsonl", SAMPLE))).toBeNull();
  expect(parser.detect(ctx(UUID + ".jsonl", "not json at all"))).toBeNull();
  expect(parser.detect(ctx(UUID + ".jsonl", '{"role":"user"}'))).toBeNull();
});

test("listConversations returns the UUID id from the filename", () => {
  const handles = parser.listConversations(ctx(WS, SAMPLE));
  expect(handles).toEqual([{ id: UUID }]);
});

test("parse maps content blocks to typed segments and is fail-soft on malformed lines", () => {
  const t = parser.parse(ctx(WS, SAMPLE), { id: UUID });
  expect(t.conversation.id).toBe(UUID);
  expect(t.conversation.agent).toBe("cursor");
  expect(t.conversation.repository).toBe("myrepo");
  expect(t.conversation.parentConversationId).toBeUndefined();

  // 4 valid JSON lines (the malformed "{ not valid json }" line is skipped)
  expect(t.messages.length).toBe(4);
  expect(t.messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);

  const segs = t.messages.flatMap((m) => m.segments);
  const kinds = segs.map((s) => s.kind);
  expect(kinds).toContain("text");
  expect(kinds).toContain("thinking");
  expect(kinds).toContain("tool_call");
  expect(kinds).toContain("tool_result");

  const call = segs.find((s) => s.kind === "tool_call")!;
  expect(call.toolName).toBe("ReadFile");
  expect(call.toolCallId).toBe("call_1");
  expect(call.content).toContain("/x");

  const result = segs.find((s) => s.kind === "tool_result")!;
  expect(result.toolCallId).toBe("call_1");
  expect(result.content).toBe("file contents");

  // plain string content → a single text segment
  const last = t.messages[t.messages.length - 1];
  expect(last.segments.length).toBe(1);
  expect(last.segments[0].kind).toBe("text");
  expect(last.segments[0].content).toBe("plain string content");

  // segment/message ids are stable and keyed on the conversation id
  expect(t.messages[0].id).toBe(`${UUID}:0`);
  expect(t.messages[0].segments[0].id).toBe(`${UUID}:0:0`);
});

test("parse derives parentConversationId for a subagent transcript path", () => {
  const t = parser.parse(ctx(SUB, SAMPLE), { id: UUID });
  expect(t.conversation.id).toBe(UUID);
  expect(t.conversation.parentConversationId).toBe(PARENT);
});

test("parse returns an empty message list for a totally malformed file without aborting", () => {
  const t = parser.parse(ctx(WS, "garbage\n{also:garbage"), { id: UUID });
  expect(t.conversation.id).toBe(UUID);
  expect(t.messages).toEqual([]);
});
