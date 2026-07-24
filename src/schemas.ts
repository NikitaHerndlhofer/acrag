/**
 * Single source of truth for all runtime-validated data shapes.
 *
 * Every external input (env vars, CLI args) is parsed through a zod
 * schema here. Internal data types are the inferred TypeScript types,
 * so we never cast or trust unchecked `unknown`.
 */
import { z } from "zod";
import { BoolFlag } from "agent-archive-core";

/* -------------------------------------------------------------------------- */
/* Environment / CLI args                                                     */
/* -------------------------------------------------------------------------- */

export const EnvSchema = z.object({
  ACRAG_ARCHIVE: z.string().optional(),
  ACRAG_SQLITE_DYLIB: z.string().optional(),
  ACRAG_OLLAMA_HOST: z.url().optional(),
  ACRAG_EMBED_MODEL: z.string().optional(),
  ACRAG_TRANSCRIPTS_DIR: z.string().optional(),
  ACRAG_CURSOR_DB: z.string().optional(),
  ACRAG_VERBOSE: BoolFlag,
  ACRAG_QUIET: BoolFlag,
});
export type Env = z.infer<typeof EnvSchema>;

export const PathOverridesSchema = z.object({
  archive: z.string().optional(),
  ollamaHost: z.url().optional(),
  embedModel: z.string().optional(),
  transcriptsDir: z.string().optional(),
  cursorDb: z.string().optional(),
});
export type PathOverrides = z.infer<typeof PathOverridesSchema>;

export const ResolvedPathsSchema = z.object({
  archive: z.string(),
  ollamaHost: z.url(),
  embedModel: z.string().min(1),
  transcriptsDir: z.string(),
  cursorDb: z.string(),
});
export type ResolvedPaths = z.infer<typeof ResolvedPathsSchema>;
