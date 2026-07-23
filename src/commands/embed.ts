import { embedOne, floatVecToBlobLiteral } from "agent-archive-core";

export interface EmbedOptions {
  text: string;
  embedModel: string;
  ollamaHost: string;
}

/**
 * Compute an embedding and emit it as a SQLite blob literal (`x'…'`).
 *
 * Designed for shell composition with `acrag sql` (both read from stdin).
 */
export async function runEmbed(opts: EmbedOptions): Promise<string> {
  const vec = await embedOne(opts.text, {
    host: opts.ollamaHost,
    model: opts.embedModel,
  });
  return `${floatVecToBlobLiteral(vec)}\n`;
}
