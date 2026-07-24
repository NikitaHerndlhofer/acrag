/**
 * Pure hook-payload parsing (design spec §7, Task 9 Step 4).
 *
 * Factored out of `commands/hook.ts` so it's testable without spawning
 * detached processes. Cursor fires one of four events and pipes a JSON
 * object on stdin; `parseHookPayload` extracts the fields the dispatcher
 * needs and returns a discriminated union (discriminated by shape — the
 * caller already knows the event, so no explicit `event` field is added,
 * keeping `toEqual` assertions exact).
 */

export type HookEvent =
  | "stop"
  | "subagentStop"
  | "subagentStart"
  | "workspaceOpen";

export interface StopPayload {
  /** Cursor conversation_id — the targeted ingest key. */
  conversationId: string;
  /** Transcript path (`transcript_path`), if Cursor provides one (null if disabled). */
  transcriptPath?: string;
}
export interface SubagentStopPayload {
  /** Parent conversation_id (base payload) — the targeted ingest key. */
  conversationId: string;
  /** Subagent id (`subagent_id`), if present. */
  subagentId?: string;
  /** Subagent transcript path (`agent_transcript_path`), if present. */
  agentTranscriptPath?: string;
}
export interface SubagentStartPayload {
  /** Row to upsert into `subagent_map` (parent link for later subagentStop). */
  record: {
    subagent_id: string;
    parent_conversation_id?: string;
    subagent_type?: string;
    task?: string;
  };
}
export interface WorkspaceOpenPayload {
  sweep: true;
}

export type HookPayload =
  | StopPayload
  | SubagentStopPayload
  | SubagentStartPayload
  | WorkspaceOpenPayload;

/** Lowercase the first character so "Stop" / "stop" both normalize to "stop". */
function normalizeEvent(event: string): string {
  return event.charAt(0).toLowerCase() + event.slice(1);
}

function parseJsonLoose(stdinJson: string): Record<string, unknown> {
  const trimmed = stdinJson.trim();
  if (trimmed.length === 0) return {};
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function parseHookPayload(
  event: string,
  stdinJson: string,
): HookPayload {
  const ev = normalizeEvent(event) as HookEvent | string;
  const p = parseJsonLoose(stdinJson);
  switch (ev) {
    case "stop": {
      const conversationId = str(p.conversation_id);
      if (!conversationId)
        throw new Error("stop hook: missing conversation_id");
      return { conversationId, transcriptPath: str(p.transcript_path) };
    }
    case "subagentStop": {
      const conversationId = str(p.conversation_id);
      if (!conversationId)
        throw new Error("subagentStop hook: missing conversation_id");
      return {
        conversationId,
        subagentId: str(p.subagent_id),
        agentTranscriptPath: str(p.agent_transcript_path),
      };
    }
    case "subagentStart": {
      const subagentId = str(p.subagent_id);
      if (!subagentId)
        throw new Error("subagentStart hook: missing subagent_id");
      return {
        record: {
          subagent_id: subagentId,
          parent_conversation_id: str(p.parent_conversation_id),
          subagent_type: str(p.subagent_type),
          task: str(p.task),
        },
      };
    }
    case "workspaceOpen":
      return { sweep: true };
    default:
      throw new Error(`parseHookPayload: unknown event "${event}"`);
  }
}
