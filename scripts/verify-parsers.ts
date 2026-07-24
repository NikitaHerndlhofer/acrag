/**
 * Dev-only: verify every parser is registered correctly and actually parses
 * real data. Run: `bun scripts/verify-parsers.ts`
 *
 * Not shipped, not tested — a manual sanity harness. Prints, does not assert.
 */
import { ensureExtensionCapableSqlite } from "../src/archive/open.ts";
import { buildDefaultRegistry } from "../src/ingest/registry.ts";
import { parser as cursorV1 } from "../src/parsers/cursor/v1.ts";
import { parser as cursorV1Jsonl } from "../src/parsers/cursor/v1-jsonl.ts";
import { parser as genericParser } from "../src/parsers/generic.ts";
import type { ArchiveSource, ConversationHandle } from "../src/contracts/source.ts";
import type { DetectContext } from "../src/contracts/parser.ts";
import type { ParsedTranscript, Segment } from "../src/contracts/types.ts";

// Bun locks the process SQLite at first `new Database`; do this before the
// sqlite parser opens anything.
ensureExtensionCapableSqlite();

const CURSOR_DB =
  process.env.ACRAG_CURSOR_DB ??
  `${process.env.HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
const CURSOR_PROJECTS =
  process.env.ACRAG_CURSOR_TRANSCRIPTS_DIR ?? `${process.env.HOME}/.cursor/projects`;

// Discover a small main transcript and a subagent transcript by globbing the
// projects tree (keeps the harness portable — no hardcoded username).
async function discoverTranscripts(): Promise<{ main: string; sub: string }> {
  const glob = new Bun.Glob("**/agent-transcripts/**/*.jsonl");
  let main = "";
  let sub = "";
  for await (const rel of glob.scan({ cwd: CURSOR_PROJECTS, absolute: true, dot: false })) {
    if (!main && !rel.includes("/subagents/")) main = rel;
    if (!sub && rel.includes("/subagents/")) sub = rel;
    if (main && sub) break;
  }
  return { main, sub };
}
const { main: JSONL_MAIN, sub: JSONL_SUB } = await discoverTranscripts();

const hr = "─".repeat(72);
const trunc = (s: string, n = 180) =>
  s.length <= n ? s : s.slice(0, n) + ` …(+${s.length - n} chars)`;

function summarize(name: string, t: ParsedTranscript): void {
  const c = t.conversation;
  const roleCount: Record<string, number> = {};
  const kindCount: Record<string, number> = {};
  for (const m of t.messages) roleCount[m.role] = (roleCount[m.role] ?? 0) + 1;
  for (const s of t.messages.flatMap((m) => m.segments))
    kindCount[s.kind] = (kindCount[s.kind] ?? 0) + 1;
  const firstText = t.messages.flatMap((m) => m.segments).find((s) => s.kind === "text");
  const firstCall = t.messages.flatMap((m) => m.segments).find((s) => s.kind === "tool_call");
  const firstResult = t.messages.flatMap((m) => m.segments).find((s) => s.kind === "tool_result");

  console.log(hr);
  console.log(`PARSER: ${name}`);
  console.log(hr);
  console.log("conversation:", {
    id: c.id,
    agent: c.agent,
    agentVersion: c.agentVersion,
    repository: c.repository,
    parentConversationId: c.parentConversationId,
  });
  console.log("messages:", t.messages.length, "| roles:", roleCount);
  console.log("segments by kind:", kindCount);
  if (firstText) console.log("sample text  :", trunc(firstText.content));
  if (firstCall)
    console.log("sample call  :", {
      toolName: firstCall.toolName,
      toolCallId: firstCall.toolCallId,
      content: trunc(firstCall.content),
    });
  if (firstResult)
    console.log("sample result:", {
      toolName: firstResult.toolName,
      toolCallId: firstResult.toolCallId,
      content: trunc(firstResult.content),
    });
  console.log("");
}

function checkRegistry(label: string, source: ArchiveSource): void {
  const reg = buildDefaultRegistry();
  const ctx: DetectContext = { source };
  const r = reg.resolve(ctx);
  console.log(`registry[${label}] →`, r ? {
    parser: r.adapter.parser.id,
    match: r.match,
    fallback: r.fallback,
    fallbackPath: r.fallbackPath,
  } : "NO PARSER");
}

// ---- 1. cursor:v1 (sqlite) on the live state.vscdb ----
{
  const source: ArchiveSource = { kind: "sqlite", dbPath: CURSOR_DB };
  const ctx: DetectContext = { source };
  console.log("\n========== REGISTRY RESOLUTION ==========");
  checkRegistry("sqlite:state.vscdb", source);
  console.log("\n========== PARSE: cursor:v1 (sqlite) ==========");
  const m = cursorV1.detect(ctx);
  console.log("detect:", m);
  const handles = cursorV1.listConversations(ctx);
  console.log("listConversations:", handles.length, "composers");
  // parse the first composer (summary truncates samples, so size is bounded)
  const target = handles[0];
  console.log("parsing handle:", target.id, "meta:", target.meta);
  const t = cursorV1.parse(ctx, target);
  summarize("cursor:v1 (sqlite)", t);
}

// ---- 2. cursor:v1-jsonl on a real transcript file ----
if (JSONL_MAIN) {
  const contents = await Bun.file(JSONL_MAIN).text();
  const source: ArchiveSource = { kind: "file", filePath: JSONL_MAIN, contents };
  const ctx: DetectContext = { source };
  checkRegistry("file:transcript(main)", source);
  console.log("\n========== PARSE: cursor:v1-jsonl (main transcript) ==========");
  const m = cursorV1Jsonl.detect(ctx);
  console.log("detect:", m);
  const handles = cursorV1Jsonl.listConversations(ctx);
  console.log("listConversations:", handles);
  const t = cursorV1Jsonl.parse(ctx, handles[0]);
  summarize("cursor:v1-jsonl (main)", t);
} else {
  console.log("\n========== PARSE: cursor:v1-jsonl (main transcript) ==========");
  console.log("(no main transcript discovered under ACRAG_CURSOR_TRANSCRIPTS_DIR — skipped)");
}

// ---- 3. cursor:v1-jsonl on a subagent transcript (parent linking) ----
if (JSONL_SUB) {
  const contents = await Bun.file(JSONL_SUB).text();
  const source: ArchiveSource = { kind: "file", filePath: JSONL_SUB, contents };
  const ctx: DetectContext = { source };
  checkRegistry("file:transcript(subagent)", source);
  console.log("\n========== PARSE: cursor:v1-jsonl (subagent transcript) ==========");
  const handles = cursorV1Jsonl.listConversations(ctx);
  const t = cursorV1Jsonl.parse(ctx, handles[0]);
  summarize("cursor:v1-jsonl (subagent)", t);
} else {
  console.log("\n========== PARSE: cursor:v1-jsonl (subagent transcript) ==========");
  console.log("(no subagent transcript discovered — skipped)");
}

// ---- 4. generic fallback on an inline non-Cursor JSONL ----
{
  const contents = [
    { role: "user", content: "what is 2+2" },
    "{ malformed line }",
    { role: "assistant", text: "4" },
  ]
    .map((o) => (typeof o === "string" ? o : JSON.stringify(o)))
    .join("\n");
  const source: ArchiveSource = { kind: "file", filePath: "notes.jsonl", contents };
  const ctx: DetectContext = { source };
  checkRegistry("file:generic(notes.jsonl)", source);
  console.log("\n========== PARSE: generic (fallback) ==========");
  const m = genericParser.detect(ctx);
  console.log("detect:", m);
  const handles = genericParser.listConversations(ctx);
  console.log("listConversations:", handles);
  const t = genericParser.parse(ctx, handles[0]);
  summarize("generic (fallback)", t);
}

console.log(hr);
console.log("verify-parsers: done");
