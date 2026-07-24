/**
 * `acrag ingest <path>` (Task 9 Step 5) — the background ingest entry point.
 *
 * Wraps `ingestSource` (Task 8) for the hook dispatcher: reads the file at
 * `<path>` into `contents`, builds a `FileSource`, and runs the idempotent
 * pipeline with opts from env/config. A parent conversation id (for subagent
 * transcripts) is forwarded via `ACRAG_PARENT_CONVERSATION_ID` by `hook.ts`.
 */
import { ingestSource } from "../ingest/ingester.ts";
import type { IngestOptions } from "../ingest/types.ts";
import { getEnv } from "../env.ts";
import { resolvePaths } from "../paths.ts";
import { error } from "../log.ts";

export async function runIngest(path: string): Promise<void> {
  const env = getEnv();
  const paths = resolvePaths({
    archive: env.ACRAG_ARCHIVE,
    ollamaHost: env.ACRAG_OLLAMA_HOST,
    embedModel: env.ACRAG_EMBED_MODEL,
  });
  const contents = await Bun.file(path).text();
  const source = { kind: "file" as const, filePath: path, contents };
  const opts: IngestOptions = {
    dbPath: paths.archive,
    ollamaHost: paths.ollamaHost,
    embedModel: paths.embedModel,
    parentConversationId: Bun.env.ACRAG_PARENT_CONVERSATION_ID,
  };
  const out = await ingestSource(source, opts);
  if (!out.applied) {
    error(`ingest: ${out.reason ?? "no changes"}`);
  }
}
