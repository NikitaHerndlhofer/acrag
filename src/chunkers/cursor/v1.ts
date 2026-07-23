/**
 * Cursor v1 chunker — segment-aware, split-never-truncate (design spec §5).
 *
 * Pure on `ParsedTranscript`: per-turn outer boundary (each message is an outer
 * boundary; segments never cross messages), segment-aware sub-chunking. Oversized
 * segments are SPLIT (never truncated) at content-aware boundaries — line-aware for
 * `code`/`tool_result`/`diff`, sentence-aware for `text`/`thinking` — each split
 * carrying a contextual header (`[<kind>: part N/M]`) and overlapping slightly with
 * its neighbours. A `tool_call` is never split away from its matching `tool_result`
 * (segments are emitted in source order, so a call's chunks always precede its
 * result's chunks within the same turn).
 *
 * Unit (for testability): "lines" for code/tool_result/diff, "sentences" for prose.
 */

import { createHash } from "node:crypto";
import type { Chunker } from "../../contracts/chunker.ts";
import type {
  Chunk,
  ChunkStrategy,
  ParsedTranscript,
  Segment,
  SegmentKind,
} from "../../contracts/types.ts";

const DEFAULT_STRATEGY: ChunkStrategy = {
  maxSegmentSize: 512,
  overlap: 2,
  threshold: 512,
  algoVersion: 1,
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isLineBased(kind: SegmentKind): boolean {
  return kind === "code" || kind === "tool_result" || kind === "diff";
}

function splitLines(content: string): string[] {
  // split/join by "\n" reproduces the original exactly (incl. trailing newline).
  return content.split("\n");
}

function splitSentences(content: string): string[] {
  if (content.length === 0) return [""];
  const m = content.match(/[^.!?]+[.!?]*\s*/g);
  return m && m.length > 0 ? m : [content];
}

function splitUnits(content: string, kind: SegmentKind): string[] {
  return isLineBased(kind) ? splitLines(content) : splitSentences(content);
}

function joinUnits(units: string[], kind: SegmentKind): string {
  return isLineBased(kind) ? units.join("\n") : units.join("");
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
  const units = splitUnits(seg.content, seg.kind);
  if (units.length <= strategy.threshold) {
    return [
      {
        segmentId: seg.id,
        sub: 0,
        chunkType: seg.kind,
        text: seg.content,
        contentHash: sha256(seg.content),
      },
    ];
  }
  const slices = makeSubChunks(
    units,
    strategy.maxSegmentSize,
    strategy.overlap,
  );
  const total = slices.length;
  const chunks: Chunk[] = [];
  slices.forEach((slice, i) => {
    const body = joinUnits(slice, seg.kind);
    const header = `[${seg.kind}: part ${i + 1}/${total}]`;
    const text = `${header}\n${body}`;
    chunks.push({
      segmentId: seg.id,
      sub: i,
      chunkType: seg.kind,
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
  versionRange: "^1",
  id: "cursor:v1",
  defaultStrategy: DEFAULT_STRATEGY,
  chunk,
};
