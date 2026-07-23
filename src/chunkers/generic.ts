/**
 * Generic fallback chunker — paired with the generic parser (registered last).
 *
 * Best-effort: coerces EVERY segment to `chunkType: "text"` (the generic parser
 * only emits `text` segments, but this chunker is also robust to transcripts
 * produced elsewhere) and sentence-splits oversized prose. Split-never-truncate,
 * each split carrying a contextual header (`[text: part N/M]`) and overlapping
 * slightly with its neighbours. Pure on `ParsedTranscript`.
 */

import { createHash } from "node:crypto";
import type { Chunker } from "../contracts/chunker.ts";
import type { Chunk, ChunkStrategy, ParsedTranscript, Segment } from "../contracts/types.ts";

const DEFAULT_STRATEGY: ChunkStrategy = {
  maxSegmentSize: 512,
  overlap: 2,
  threshold: 512,
  algoVersion: 1,
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function splitSentences(content: string): string[] {
  if (content.length === 0) return [""];
  const m = content.match(/[^.!?]+[.!?]*\s*/g);
  return m && m.length > 0 ? m : [content];
}

function makeSubChunks(
  units: string[],
  maxSegmentSize: number,
  overlap: number,
): string[][] {
  const total = units.length;
  if (total <= maxSegmentSize) return [units];
  const step = Math.max(1, maxSegmentSize - overlap);
  const out: string[][] = [];
  let start = 0;
  while (start < total) {
    const end = Math.min(start + maxSegmentSize, total);
    out.push(units.slice(start, end));
    if (end >= total) break;
    start += step;
  }
  return out;
}

function chunkSegment(seg: Segment, strategy: ChunkStrategy): Chunk[] {
  const units = splitSentences(seg.content);
  if (units.length <= strategy.threshold) {
    return [
      {
        segmentId: seg.id,
        sub: 0,
        chunkType: "text",
        text: seg.content,
        contentHash: sha256(seg.content),
      },
    ];
  }
  const slices = makeSubChunks(units, strategy.maxSegmentSize, strategy.overlap);
  const total = slices.length;
  const chunks: Chunk[] = [];
  slices.forEach((slice, i) => {
    const body = slice.join("");
    const header = `[text: part ${i + 1}/${total}]`;
    const text = `${header}\n${body}`;
    chunks.push({
      segmentId: seg.id,
      sub: i,
      chunkType: "text",
      text,
      contentHash: sha256(text),
    });
  });
  return chunks;
}

function chunk(transcript: ParsedTranscript, strategy?: ChunkStrategy): Chunk[] {
  const s = strategy ?? chunker.defaultStrategy;
  const out: Chunk[] = [];
  for (const msg of transcript.messages) {
    for (const seg of msg.segments) {
      for (const c of chunkSegment(seg, s)) out.push(c);
    }
  }
  return out;
}

export const chunker: Chunker = {
  agent: "cursor",
  versionRange: undefined,
  id: "generic",
  defaultStrategy: DEFAULT_STRATEGY,
  chunk,
};
