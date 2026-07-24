import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  PathOverridesSchema,
  ResolvedPathsSchema,
  type PathOverrides,
  type ResolvedPaths,
} from "./schemas.ts";

const HOME = homedir();

/**
 * Default Cursor `state.vscdb` location. Only macOS has a known default; on
 * other platforms the user must set `ACRAG_CURSOR_DB`. An empty string means
 * "no Cursor source configured" — `acrag index` then skips the DB sweep.
 */
function defaultCursorDb(): string {
  if (platform() === "darwin") {
    return join(
      HOME,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  return "";
}

export const DEFAULTS = {
  archive: join(HOME, ".acrag", "acrag.sqlite"),
  ollamaHost: "http://127.0.0.1:11434",
  embedModel: "bge-m3",
  transcriptsDir: join(HOME, ".acrag", "transcripts"),
  cursorDb: defaultCursorDb(),
};

export type { ResolvedPaths };

/**
 * Build a fully populated `ResolvedPaths` from optional overrides. Both the
 * input and the output are validated, so we never carry around partially
 * filled paths or stringy URLs. The archive's parent directory is derived
 * at use-site via `dirname()` — it's never an independent override.
 */
export function resolvePaths(overrides: unknown = {}): ResolvedPaths {
  const o: PathOverrides = PathOverridesSchema.parse(overrides);
  return ResolvedPathsSchema.parse({
    archive: o.archive ?? DEFAULTS.archive,
    ollamaHost: o.ollamaHost ?? DEFAULTS.ollamaHost,
    embedModel: o.embedModel ?? DEFAULTS.embedModel,
    transcriptsDir: o.transcriptsDir ?? DEFAULTS.transcriptsDir,
    cursorDb: o.cursorDb ?? DEFAULTS.cursorDb,
  });
}
