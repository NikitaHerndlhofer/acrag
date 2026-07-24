import { test, expect } from "bun:test";
import { parseHookPayload } from "../src/hooks/payload.ts";
import { renderHooksJson } from "../src/hooks/hooks.json.ts";

test("stop extracts transcript_path", () => {
  const out = parseHookPayload(
    "stop",
    JSON.stringify({ transcript_path: "/a/b.jsonl", conversation_id: "c1" }),
  );
  expect(out).toEqual({ ingestPath: "/a/b.jsonl", conversationId: "c1" });
});

test("subagentStop extracts agent_transcript_path + subagent_id", () => {
  const out = parseHookPayload(
    "subagentStop",
    JSON.stringify({ agent_transcript_path: "/sub.jsonl", subagent_id: "s2" }),
  );
  expect(out).toEqual({ ingestPath: "/sub.jsonl", subagentId: "s2" });
});

test("workspaceOpen dispatches a sweep (no path)", () => {
  const out = parseHookPayload("workspaceOpen", "{}");
  expect(out).toEqual({ sweep: true });
});

test("renderHooksJson emits one acrag hook command per event", () => {
  const json = renderHooksJson({ acragBin: "/usr/local/bin/acrag" });
  const obj = JSON.parse(json);
  const events = new Set(Object.keys(obj));
  for (const e of ["Stop", "SubagentStop", "SubagentStart", "WorkspaceOpen"]) {
    expect(events.has(e)).toBe(true);
    expect(obj[e].command).toContain("acrag hook");
  }
});
