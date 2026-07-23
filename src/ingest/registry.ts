import type {
  AgentAdapter,
  AgentRegistry,
  ResolvedAdapter,
  FallbackPath,
} from "../contracts/registry.ts";
import type { DetectContext, ParserMatch } from "../contracts/parser.ts";
import type { ConversationHandle } from "../contracts/source.ts";
import type { ChunkStrategy } from "../contracts/types.ts";
import type { Chunk, ParsedTranscript } from "../contracts/types.ts";
import {
  satisfies,
  minOf,
  maxOf,
  parseVer,
  compareVersions,
  type Version,
} from "./version.ts";
import { parser as cursorV1 } from "../parsers/cursor/v1.ts";
import { chunker as cursorV1Chunker } from "../chunkers/cursor/v1.ts";
import { parser as genericParser } from "../parsers/generic.ts";
import { chunker as genericChunker } from "../chunkers/generic.ts";

interface Claim {
  adapter: AgentAdapter;
  match: ParserMatch;
}

/** Attempt a probe parse to detect drift. Empty source (no handles) counts as success. */
function probeSucceeds(adapter: AgentAdapter, ctx: DetectContext): boolean {
  let handles: ConversationHandle[];
  try {
    handles = adapter.parser.listConversations(ctx);
  } catch {
    return false;
  }
  if (handles.length === 0) return true;
  try {
    adapter.parser.parse(ctx, handles[0]);
    return true;
  } catch {
    return false;
  }
}

function resolved(
  claim: Claim,
  fallback: boolean,
  fallbackPath: FallbackPath,
): ResolvedAdapter {
  return {
    adapter: claim.adapter,
    match: claim.match,
    fallback,
    fallbackPath,
  };
}

export function createRegistry(): AgentRegistry {
  const adapters: AgentAdapter[] = [];

  const registry: AgentRegistry = {
    register(adapter: AgentAdapter): void {
      adapters.push(adapter);
    },

    resolve(ctx: DetectContext): ResolvedAdapter | null {
      // Collect claimers in registration order.
      const claims: Claim[] = [];
      for (const adapter of adapters) {
        let match: ParserMatch | null = null;
        try {
          match = adapter.parser.detect(ctx);
        } catch {
          match = null;
        }
        if (match) claims.push({ adapter, match });
      }
      if (claims.length === 0) return null;

      const detected = claims[0].match.version;
      const detectedVer: Version | null =
        detected !== undefined ? parseVer(detected) : null;

      // Find exact: claimers whose range satisfies the detected version.
      let exact: Claim | null = null;
      if (detectedVer) {
        const satisfying = claims.filter((c) =>
          c.adapter.versionRange !== undefined
            ? satisfies(detected!, c.adapter.versionRange)
            : true,
        );
        // "generic" (undefined range) only claims as exact when no bounded parser does;
        // prefer bounded matches over generic for the exact slot.
        const bounded = satisfying.filter(
          (c) => c.adapter.versionRange !== undefined,
        );
        const pool = bounded.length > 0 ? bounded : satisfying;
        // Newest range wins: highest lower bound, then highest upper bound.
        const sorted = [...pool].sort((a, b) => {
          const c = compareVersions(
            minOf(a.adapter.versionRange),
            minOf(b.adapter.versionRange),
          );
          if (c !== 0) return -c;
          return -compareVersions(
            maxOf(a.adapter.versionRange),
            maxOf(b.adapter.versionRange),
          );
        });
        exact = sorted[0] ?? null;
      }

      // Exact path.
      if (exact) {
        if (probeSucceeds(exact.adapter, ctx)) {
          return resolved(exact, false, "exact");
        }
      }

      // Fallback chain: nearest-below → nearest-above → generic.
      const candidates = claims.filter((c) => c !== exact);

      const below: Claim[] = [];
      const above: Claim[] = [];
      const generic: Claim[] = [];
      if (detectedVer) {
        for (const c of candidates) {
          const range = c.adapter.versionRange;
          if (range === undefined) {
            generic.push(c);
            continue;
          }
          const lo = minOf(range);
          const cmp = compareVersions(lo, detectedVer);
          if (cmp < 0) below.push(c);
          else if (cmp > 0) above.push(c);
        }
        below.sort(
          (a, b) =>
            -compareVersions(
              minOf(a.adapter.versionRange),
              minOf(b.adapter.versionRange),
            ),
        );
        above.sort(
          (a, b) =>
            compareVersions(
              minOf(a.adapter.versionRange),
              minOf(b.adapter.versionRange),
            ),
        );
      } else {
        // No comparable detected version: only generic can help.
        for (const c of candidates) {
          if (c.adapter.versionRange === undefined) generic.push(c);
        }
      }

      const chain: { claim: Claim; path: FallbackPath }[] = [
        ...below.map((c) => ({ claim: c, path: "nearest-below" as const })),
        ...above.map((c) => ({ claim: c, path: "nearest-above" as const })),
        ...generic.map((c) => ({ claim: c, path: "generic" as const })),
      ];

      for (const { claim, path } of chain) {
        if (probeSucceeds(claim.adapter, ctx)) {
          return resolved(claim, true, path);
        }
      }

      return null;
    },

    parseAndChunk(
      ctx: DetectContext,
      handle: ConversationHandle,
      strategy?: ChunkStrategy,
    ): {
      transcript: ParsedTranscript;
      chunks: Chunk[];
      match: ParserMatch;
      fallback: boolean;
    } | null {
      const r = registry.resolve(ctx);
      if (!r) return null;
      const transcript = r.adapter.parser.parse(ctx, handle);
      const chunks = r.adapter.chunker.chunk(transcript, strategy);
      return {
        transcript,
        chunks,
        match: r.match,
        fallback: r.fallback,
      };
    },
  };

  return registry;
}

export function buildDefaultRegistry(): AgentRegistry {
  const r = createRegistry();
  r.register({
    agent: "cursor",
    versionRange: "^1",
    parser: cursorV1,
    chunker: cursorV1Chunker,
  });
  r.register({
    agent: "cursor",
    parser: genericParser,
    chunker: genericChunker,
  }); // last = fallback
  return r;
}
