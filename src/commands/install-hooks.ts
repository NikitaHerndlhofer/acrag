/**
 * `acrag install-hooks` — write acrag's entries into Cursor's user-level
 * `hooks.json` and print a short settings snippet.
 *
 * Cursor reads user hooks from `~/.cursor/hooks.json` (NOT `~/.cursor/hooks/` —
 * that dir holds hook *scripts*). The file uses schema version 1 with events
 * nested under `hooks` as arrays. If a hooks.json already exists (other tools,
 * user-defined hooks), acrag MERGES its four events in, preserving everything
 * else; it never overwrites unrelated hooks.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  renderHooksJson,
  ACRAG_HOOK_EVENTS,
} from "../hooks/hooks.json.ts";
import { info } from "../log.ts";

export interface InstallHooksOptions {
  /** Target hooks.json path (defaults to ~/.cursor/hooks.json). */
  targetPath?: string;
  /** Override the acrag binary invocation (defaults to `acrag` on PATH). */
  acragBin?: string;
}

function defaultAcragBin(): string {
  // The brew-installed CLI is `acrag` on PATH. Using the bare name keeps the
  // hooks.json portable across machines/installs. (The previous logic emitted
  // `<bun-runtime> hook <Event>`, which was neither a valid acrag invocation
  // nor Cursor's event casing.)
  return "acrag";
}

interface CursorHooksJson {
  version?: number;
  hooks?: Record<string, unknown>;
}

/** Deep-merge acrag's events into an existing hooks.json, preserving others. */
function mergeHooks(existingPath: string, acragJson: string): string {
  let existing: CursorHooksJson = {};
  try {
    existing = JSON.parse(readFileSync(existingPath, "utf8")) as CursorHooksJson;
  } catch {
    existing = {}; // unreadable/unparseable — start fresh
  }
  const acrag = JSON.parse(acragJson) as CursorHooksJson;
  const hooks: Record<string, unknown> = { ...(existing.hooks ?? {}) };
  const acragHooks = acrag.hooks ?? {};
  for (const e of ACRAG_HOOK_EVENTS) {
    // Replace only acrag's own events; leave unrelated events untouched.
    hooks[e] = acragHooks[e];
  }
  const merged: CursorHooksJson = { version: 1, ...existing, hooks };
  return JSON.stringify(merged, null, 2);
}

export function installHooks(opts: InstallHooksOptions = {}): {
  path: string;
  json: string;
} {
  const target = opts.targetPath ?? join(homedir(), ".cursor", "hooks.json");
  const acragBin = opts.acragBin ?? defaultAcragBin();
  const rendered = renderHooksJson({ acragBin });
  const json = existsSync(target) ? mergeHooks(target, rendered) : rendered;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json + "\n", "utf8");
  info(`wrote ${target}`);
  return { path: target, json };
}

export function renderSettingsSnippet(path: string): string {
  return [
    `Installed acrag hooks to: ${path}`,
    `Cursor auto-loads ~/.cursor/hooks.json — restart Cursor if it doesn't pick them up.`,
    `Set ACRAG_ARCHIVE / ACRAG_OLLAMA_HOST / ACRAG_EMBED_MODEL / ACRAG_CURSOR_DB to override defaults.`,
  ].join("\n");
}
