/**
 * Render the Cursor `hooks.json` (Task 9 Step 4).
 *
 * Maps each Cursor event (Stop / SubagentStop / SubagentStart / WorkspaceOpen)
 * to a detached `acrag hook <event>` command so the agent never blocks on
 * embedding — the hook process spawns a background ingest/sweep and exits 0.
 */
export interface RenderHooksJsonOptions {
  /** Absolute path to the `acrag` binary the hook should invoke. */
  acragBin: string;
}

const CURSOR_EVENTS = [
  "Stop",
  "SubagentStop",
  "SubagentStart",
  "WorkspaceOpen",
] as const;

export function renderHooksJson(opts: RenderHooksJsonOptions): string {
  const { acragBin } = opts;
  const obj: Record<string, { command: string }> = {};
  for (const e of CURSOR_EVENTS) {
    obj[e] = { command: `${acragBin} hook ${e}` };
  }
  return JSON.stringify(obj, null, 2);
}
