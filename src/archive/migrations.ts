import type { Migration } from "agent-archive-core";
import init from "./migrations/001_init.sql" with { type: "text" };
import subagentMap from "./migrations/002_subagent_map.sql" with { type: "text" };

// Task 2 appends further migrations (002+) that expand `conversation` and add
// message / segment / chunk / FTS5 / vec0. Never edit a shipped migration.
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "init", sql: init },
  { version: 2, name: "subagent_map", sql: subagentMap },
];

/** Latest schema version known to this binary. */
export const LATEST_VERSION: number = Math.max(
  ...MIGRATIONS.map((m) => m.version),
);
