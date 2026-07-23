// tests/registry.test.ts
// Adapted for the ArchiveSource/ConversationHandle contracts: DetectContext carries
// `source` (a FileSource/SqliteSource), parsers expose listConversations + parse(ctx, handle),
// and AgentRegistry.parseAndChunk takes a ConversationHandle.
import { test, expect } from "bun:test";
import { createRegistry } from "../src/ingest/registry.ts";
import type { AgentAdapter } from "../src/contracts/registry.ts";
import type { DetectContext, Parser } from "../src/contracts/parser.ts";
import type { Chunker } from "../src/contracts/chunker.ts";
import type { ConversationHandle } from "../src/contracts/source.ts";

const mkAdapter = (
  agent: any,
  range: any,
  willThrow: boolean,
): AgentAdapter => {
  const parser: Parser = {
    agent,
    versionRange: range,
    id: `${agent}:${range ?? "any"}`,
    detect: (ctx) => {
      if (ctx.source.kind !== "file") return null;
      const claims = ctx.agentHint === agent || ctx.source.filePath.includes(agent);
      if (!claims) return null;
      return { agent, version: ctx.source.contents.trim() || undefined, note: "mock" };
    },
    listConversations: (ctx): ConversationHandle[] => {
      if (ctx.source.kind !== "file") return [];
      return [{ id: ctx.source.filePath }];
    },
    parse: (_ctx, handle) => {
      if (willThrow) throw new Error("drift");
      return { conversation: { id: handle.id, agent }, messages: [] };
    },
  };
  const chunker: Chunker = {
    agent,
    versionRange: range,
    id: `${agent}:${range ?? "any"}`,
    defaultStrategy: {
      maxSegmentSize: 512,
      overlap: 2,
      threshold: 512,
      algoVersion: 1,
    },
    chunk: () => [],
  };
  return { agent, versionRange: range, parser, chunker };
};

const ctx = (agent: string, version: string): DetectContext => ({
  source: { kind: "file", filePath: `/${agent}/x.jsonl`, contents: version },
  agentHint: agent as any,
});

test("exact version match wins", () => {
  const r = createRegistry();
  r.register(mkAdapter("cursor", "^1", false));
  r.register(mkAdapter("cursor", "^2", false));
  const res = r.resolve(ctx("cursor", "1.5"));
  expect(res?.match.version).toBe("1.5");
  expect(res?.fallbackPath).toBe("exact");
  expect(res?.fallback).toBe(false);
});

test("nearest-below fallback when exact parser throws (drift)", () => {
  const r = createRegistry();
  r.register(mkAdapter("cursor", "^9", true)); // exact for v9.5 but throws
  r.register(mkAdapter("cursor", "^7", false)); // nearest-below
  r.register(mkAdapter("cursor", "^3", false)); // further below
  const res = r.resolve(ctx("cursor", "9.5"));
  expect(res?.fallbackPath).toBe("nearest-below");
  expect(res?.adapter.parser.id).toBe("cursor:^7");
});

test("nearest-above fallback when detected is older than every parser", () => {
  const r = createRegistry();
  r.register(mkAdapter("cursor", "^5", false));
  r.register(mkAdapter("cursor", "^8", false));
  const res = r.resolve(ctx("cursor", "2.0"));
  expect(res?.fallbackPath).toBe("nearest-above");
  expect(res?.adapter.parser.id).toBe("cursor:^5");
});

test("generic fallback when all parsers fail or version unknown", () => {
  const r = createRegistry();
  r.register(mkAdapter("cursor", "^1", true));
  // generic registered last, agent-agnostic
  r.register({
    agent: "cursor",
    parser: {
      agent: "cursor",
      id: "generic",
      detect: () => ({ agent: "cursor", version: undefined, note: "generic" }),
      listConversations: (ctx: DetectContext): ConversationHandle[] =>
        ctx.source.kind === "file" ? [{ id: ctx.source.filePath }] : [],
      parse: (_ctx: DetectContext, handle: ConversationHandle) => ({
        conversation: { id: handle.id, agent: "cursor" },
        messages: [],
      }),
    } as any,
    chunker: {
      agent: "cursor",
      id: "generic",
      defaultStrategy: {
        maxSegmentSize: 512,
        overlap: 2,
        threshold: 512,
        algoVersion: 1,
      },
      chunk: () => [],
    } as any,
  });
  const res = r.resolve(ctx("cursor", "1.0"));
  expect(res?.fallbackPath).toBe("generic");
  expect(res?.fallback).toBe(true);
});

test("parseAndChunk runs parse -> chunk", () => {
  const r = createRegistry();
  r.register(mkAdapter("cursor", "^1", false));
  const c = ctx("cursor", "1.0");
  const handle = r.resolve(c)?.adapter.parser.listConversations(c)[0]!;
  const out = r.parseAndChunk(c, handle);
  expect(out).not.toBeNull();
  expect(out!.transcript.conversation.agent).toBe("cursor");
  expect(Array.isArray(out!.chunks)).toBe(true);
});
