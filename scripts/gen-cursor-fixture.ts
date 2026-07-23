/**
 * Deterministic PII-free Cursor state.vscdb fixture generator.
 * Produces tests/fixtures/cursor/v1-sample.vscdb with real schema shapes.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const outPath = join(import.meta.dir, "../tests/fixtures/cursor/v1-sample.vscdb");
mkdirSync(dirname(outPath), { recursive: true });

try {
  const { unlinkSync, existsSync } = await import("node:fs");
  if (existsSync(outPath)) unlinkSync(outPath);
} catch {
  /* ignore */
}

const db = new Database(outPath);
db.exec(`
  CREATE TABLE composerHeaders (
    composerId TEXT PRIMARY KEY,
    workspaceId TEXT,
    createdAt INTEGER,
    lastUpdatedAt INTEGER,
    isArchived INTEGER,
    isSubagent INTEGER,
    recency INTEGER,
    checkpointAt INTEGER,
    value TEXT
  );
  CREATE TABLE cursorDiskKV (
    key TEXT UNIQUE ON CONFLICT REPLACE,
    value BLOB
  );
`);

const cid = "00000000-0000-4000-8000-000000000001";
const bidUser = "11111111-1111-4111-8111-111111111111";
const bidAsst = "22222222-2222-4222-8222-222222222222";
const bidTool = "33333333-3333-4333-8333-333333333333";
const bidDiff = "44444444-4444-4444-8444-444444444444";
const toolCallId = "tool-call-placeholder-001";
// composerHeaders timestamps are epoch-ms NUMBERS (real Cursor); bubble.createdAt is an ISO STRING.
const createdAt = 1_700_000_000_000;
const lastUpdatedAt = 1_700_000_100_000;
const t0 = "2023-11-14T22:13:20.000Z";
const t1 = "2023-11-14T22:13:20.001Z";
const t2 = "2023-11-14T22:13:20.002Z";
const t3 = "2023-11-14T22:13:20.003Z";

const headerValue = {
  type: "composerHeader",
  composerId: cid,
  name: "FIXTURE_CONVERSATION_NAME",
  subtitle: "FIXTURE_SUBTITLE",
  createdAt,
  isArchived: false,
  isWorktree: false,
  isSpec: false,
  numSubComposers: 0,
  trackedGitRepos: ["https://github.com/example/fixture-repo.git"],
  workspaceIdentifier: { id: "ws-fixture", uri: "file:///tmp/fixture-workspace" },
};

db.run(
  `INSERT INTO composerHeaders
    (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  cid,
  "ws-fixture",
  createdAt,
  lastUpdatedAt,
  0,
  0,
  lastUpdatedAt,
  null,
  JSON.stringify(headerValue),
);

const composerData = {
  status: "completed",
  text: "",
  richText: "",
  fullConversationHeadersOnly: [
    { bubbleId: bidUser, type: 1, serverBubbleId: null, grouping: null },
    { bubbleId: bidAsst, type: 2, serverBubbleId: null, grouping: null },
    { bubbleId: bidTool, type: 2, serverBubbleId: null, grouping: null },
    { bubbleId: bidDiff, type: 2, serverBubbleId: null, grouping: null },
  ],
  conversationMap: {},
  context: {},
  codeBlockData: {},
  originalFileStates: {},
  _v: 17,
};

const userBubble = {
  type: 1,
  text: "USER_PROMPT_PLACEHOLDER",
  richText: "USER_PROMPT_PLACEHOLDER",
  createdAt: t0,
  allThinkingBlocks: [],
  suggestedCodeBlocks: [],
  toolResults: [],
  gitDiffs: [],
  assistantSuggestedDiffs: [],
  todos: [],
  tokenCount: { input: 10, output: 0 },
  isAgentic: false,
  _v: 1,
};

const asstBubble = {
  type: 2,
  text: "ASSISTANT_PROSE_PLACEHOLDER",
  richText: "",
  createdAt: t1,
  allThinkingBlocks: [
    { thinking: "THINKING_PLACEHOLDER", text: "THINKING_PLACEHOLDER" },
  ],
  suggestedCodeBlocks: [
    {
      language: "typescript",
      code: "// CODE_PLACEHOLDER\nconst x = 1;\n",
      content: "// CODE_PLACEHOLDER\nconst x = 1;\n",
    },
  ],
  toolResults: [],
  gitDiffs: [],
  assistantSuggestedDiffs: [],
  todos: [],
  tokenCount: { input: 10, output: 20 },
  isAgentic: true,
  _v: 1,
};

const toolBubble = {
  type: 2,
  text: "",
  richText: "",
  createdAt: t2,
  allThinkingBlocks: [],
  suggestedCodeBlocks: [],
  toolResults: [
    {
      tool_call_id: toolCallId,
      toolCallId,
      toolName: "Read",
      name: "Read",
      content: "TOOL_RESULT_PLACEHOLDER",
      result: "TOOL_RESULT_PLACEHOLDER",
    },
  ],
  toolFormerData: {
    toolCallId,
    toolIndex: 0,
    modelCallId: "model-call-placeholder",
    status: "completed",
    name: "Read",
    rawArgs: JSON.stringify({ path: "FILE_PLACEHOLDER.ts" }),
    tool: 40,
    params: JSON.stringify({ path: "FILE_PLACEHOLDER.ts" }),
    result: "TOOL_RESULT_PLACEHOLDER",
  },
  gitDiffs: [],
  assistantSuggestedDiffs: [],
  todos: [],
  isAgentic: true,
  _v: 1,
};

const diffBubble = {
  type: 2,
  text: "DIFF_INTRO_PLACEHOLDER",
  richText: "",
  createdAt: t3,
  allThinkingBlocks: [],
  suggestedCodeBlocks: [],
  toolResults: [],
  gitDiffs: [
    {
      path: "FILE_PLACEHOLDER.ts",
      diff: "--- a/FILE_PLACEHOLDER.ts\n+++ b/FILE_PLACEHOLDER.ts\n@@ -1 +1 @@\n-OLD_PLACEHOLDER\n+NEW_PLACEHOLDER\n",
      content: "--- a/FILE_PLACEHOLDER.ts\n+++ b/FILE_PLACEHOLDER.ts\n@@ -1 +1 @@\n-OLD_PLACEHOLDER\n+NEW_PLACEHOLDER\n",
    },
  ],
  assistantSuggestedDiffs: [
    {
      path: "OTHER_FILE_PLACEHOLDER.ts",
      diff: "--- a/OTHER_FILE_PLACEHOLDER.ts\n+++ b/OTHER_FILE_PLACEHOLDER.ts\n@@ -0,0 +1 @@\n+SUGGESTED_PLACEHOLDER\n",
    },
  ],
  todos: [],
  isAgentic: true,
  _v: 1,
};

const put = (key: string, obj: unknown) => {
  db.run(
    "INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)",
    key,
    Buffer.from(JSON.stringify(obj), "utf8"),
  );
};

put(`composerData:${cid}`, composerData);
put(`bubbleId:${cid}:${bidUser}`, userBubble);
put(`bubbleId:${cid}:${bidAsst}`, asstBubble);
put(`bubbleId:${cid}:${bidTool}`, toolBubble);
put(`bubbleId:${cid}:${bidDiff}`, diffBubble);

db.close();
console.log("Wrote", outPath);
