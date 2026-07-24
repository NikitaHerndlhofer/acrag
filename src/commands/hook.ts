/**
 * `acrag hook <event>` — Cursor hook dispatcher.
 *
 * Reads the hook JSON payload from stdin and dispatches a **detached** background
 * `acrag ingest-cursor`/`acrag index` so the agent never waits on embedding.
 * Exits 0 instantly.
 *
 *   stop         -> acrag ingest-cursor <conversation_id>  (targeted re-ingest)
 *   subagentStop -> acrag ingest-cursor <conversation_id>  (parent conversation)
 *   subagentStart -> upsert subagent_map (sync, fast)
 *   workspaceOpen -> acrag index                            (full idempotent sweep)
 */
import { readAllStdin } from "agent-archive-core";
import { parseHookPayload, type HookPayload } from "../hooks/payload.ts";
import { openArchive } from "../archive/open.ts";
import { error } from "../log.ts";

/** Reconstruct the `acrag` invocation (dev `bun src/cli.ts` vs compiled binary). */
function acragInvoke(args: string[]): { cmd: string; args: string[] } {
  const entry = process.argv[1] ?? "";
  if (entry.endsWith("cli.ts") || entry.endsWith("cli.js")) {
    return { cmd: process.execPath, args: [entry, ...args] };
  }
  return { cmd: process.execPath, args };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Spawn a detached, nohup-style background process and return immediately. */
function spawnDetached(args: string[], extraEnv: Record<string, string> = {}): void {
  const inv = acragInvoke(args);
  const line = `nohup ${shellQuote(inv.cmd)} ${inv.args.map(shellQuote).join(" ")} > /dev/null 2>&1 &`;
  Bun.spawn({
    cmd: ["sh", "-c", line],
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...Bun.env, ...extraEnv },
  });
}

/** Upsert a subagent→parent link (recorded on subagentStart for later linking). */
function upsertSubagentMap(
  dbPath: string,
  record: { subagent_id: string; parent_conversation_id?: string; subagent_type?: string; task?: string },
): void {
  const db = openArchive(dbPath, {});
  try {
    db.prepare(
      "INSERT INTO subagent_map (subagent_id, parent_conversation_id, subagent_type, task) " +
        "VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(subagent_id) DO UPDATE SET " +
        "parent_conversation_id = excluded.parent_conversation_id, " +
        "subagent_type = excluded.subagent_type, task = excluded.task",
    ).run(
      record.subagent_id,
      record.parent_conversation_id ?? null,
      record.subagent_type ?? null,
      record.task ?? null,
    );
  } finally {
    db.close();
  }
}

export async function runHook(event: string, dbPath: string): Promise<void> {
  const stdin = await readAllStdin();
  let payload: HookPayload;
  try {
    payload = parseHookPayload(event, stdin);
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    process.exit(0);
  }

  if ("sweep" in payload) {
    spawnDetached(["index"]);
    return;
  }
  if ("record" in payload) {
    upsertSubagentMap(dbPath, payload.record);
    return;
  }
  // stop / subagentStop -> targeted ingest of conversation_id from state.vscdb
  spawnDetached(["ingest-cursor", payload.conversationId]);
}

