import { test, expect } from "bun:test";
import { parseHookPayload } from "../src/hooks/payload.ts";
import { renderHooksJson } from "../src/hooks/hooks.json.ts";

test("stop extracts conversation_id (+ optional transcript_path)", () => {
  const out = parseHookPayload(
    "stop",
    JSON.stringify({ transcript_path: "/a/b.jsonl", conversation_id: "c1" }),
  );
  expect(out).toEqual({ conversationId: "c1", transcriptPath: "/a/b.jsonl" });
});

test("stop requires conversation_id", () => {
  expect(() =>
    parseHookPayload("stop", JSON.stringify({ transcript_path: "/a/b.jsonl" })),
  ).toThrow();
});

test("subagentStop extracts conversation_id (+ optional subagent fields)", () => {
  const out = parseHookPayload(
    "subagentStop",
    JSON.stringify({
      conversation_id: "parent-1",
      subagent_id: "s2",
      agent_transcript_path: "/sub.jsonl",
    }),
  );
  expect(out).toEqual({
    conversationId: "parent-1",
    subagentId: "s2",
    agentTranscriptPath: "/sub.jsonl",
  });
});

test("workspaceOpen dispatches a sweep (no path)", () => {
  const out = parseHookPayload("workspaceOpen", "{}");
  expect(out).toEqual({ sweep: true });
});

test("renderHooksJson emits Cursor's v1 schema with camelCase events", () => {
  const json = renderHooksJson({ acragBin: "/usr/local/bin/acrag" });
  const obj = JSON.parse(json);
  expect(obj.version).toBe(1);
  expect(obj.hooks).toBeDefined();
  for (const e of ["stop", "subagentStop", "subagentStart", "workspaceOpen"]) {
    expect(Array.isArray(obj.hooks[e])).toBe(true);
    expect(obj.hooks[e][0].command).toBe(`/usr/local/bin/acrag hook ${e}`);
  }
});

test("renderHooksJson default acragBin is bare 'acrag' on PATH", () => {
  const obj = JSON.parse(renderHooksJson({ acragBin: "acrag" }));
  expect(obj.hooks.stop[0].command).toBe("acrag hook stop");
});
