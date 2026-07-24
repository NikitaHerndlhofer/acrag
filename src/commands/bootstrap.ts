/**
 * `acrag bootstrap` (Task 12 Step 3) — check Ollama, create the archive DB
 * (running migrations), and print a one-shot status line.
 *
 * Mirrors `commands/index.ts`: the cli entry resolves paths from env via
 * `getEnv`/`resolvePaths` and hands a `ResolvedPaths` in. We probe Ollama
 * (non-fatal — a diagnostic string is returned when it's down, never thrown),
 * then open the archive read-write so the core's `openArchive` runs the
 * `ACRAG_SCHEMA` migrations + seeds config (idempotent via `user_version`),
 * and finally print the archive path, embed model, Ollama reachability, and
 * conversation count.
 */
import { checkOllama } from "agent-archive-core";
import { openArchive } from "../archive/open.ts";
import type { ResolvedPaths } from "../paths.ts";

export interface RunBootstrapArgs {
  paths: ResolvedPaths;
}

export interface BootstrapOutcome {
  archive: string;
  embedModel: string;
  /** null when Ollama is reachable + the model is pulled; otherwise a diagnostic. */
  ollama: string | null;
  conversations: number;
}

export async function runBootstrap({
  paths,
}: RunBootstrapArgs): Promise<BootstrapOutcome> {
  const ollama = await checkOllama({
    host: paths.ollamaHost,
    model: paths.embedModel,
  });
  // Create the archive + run migrations (idempotent via PRAGMA user_version).
  const db = openArchive(paths.archive, {});
  let conversations: number;
  try {
    const row = db
      .query("SELECT COUNT(*) AS c FROM conversation")
      .get() as { c: number };
    conversations = row.c;
  } finally {
    db.close();
  }
  const outcome: BootstrapOutcome = {
    archive: paths.archive,
    embedModel: paths.embedModel,
    ollama,
    conversations,
  };
  process.stdout.write(renderBootstrapStatus(outcome) + "\n");
  return outcome;
}

export function renderBootstrapStatus(out: BootstrapOutcome): string {
  const ollamaLine =
    out.ollama == null
      ? `ollama: reachable (${out.embedModel})`
      : `ollama: NOT reachable — ${out.ollama}`;
  return [
    `archive: ${out.archive}`,
    `embed model: ${out.embedModel}`,
    ollamaLine,
    `conversations: ${out.conversations}`,
  ].join("\n");
}
