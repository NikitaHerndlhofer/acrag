/**
 * Render the Cursor `hooks.json` (user-level).
 *
 * Cursor's schema (https://cursor.com/docs/hooks, version 1):
 *   { "version": 1, "hooks": { "<event>": [ { "command": "..." } ] } }
 *
 * Events are camelCase (`stop`, `subagentStop`, `subagentStart`, `workspaceOpen`),
 * nested under `hooks`, and each maps to an ARRAY of hook definitions. The
 * hook command reads the event JSON from stdin and spawns a detached
 * `acrag ingest-cursor`/`acrag index` so the agent never blocks on embedding.
 */
export interface RenderHooksJsonOptions {
  /** The `acrag` invocation the hook should run (default `"acrag"` on PATH). */
  acragBin: string;
}

const CURSOR_EVENTS = [
  "stop",
  "subagentStop",
  "subagentStart",
  "workspaceOpen",
] as const;

export function renderHooksJson(opts: RenderHooksJsonOptions): string {
  const { acragBin } = opts;
  const hooks: Record<string, Array<{ command: string }>> = {};
  for (const e of CURSOR_EVENTS) {
    hooks[e] = [{ command: `${acragBin} hook ${e}` }];
  }
  return JSON.stringify({ version: 1, hooks }, null, 2);
}

/** Event names acrag registers (camelCase, matching Cursor's spec). */
export const ACRAG_HOOK_EVENTS = CURSOR_EVENTS;

