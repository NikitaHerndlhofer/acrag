/**
 * `acrag install-hooks` (Task 9 Step 5) — write `hooks.json` into the Cursor
 * hooks directory and print a short settings snippet.
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { renderHooksJson } from "../hooks/hooks.json.ts";
import { info } from "../log.ts";

export interface InstallHooksOptions {
  /** Target hooks.json path (defaults to ~/.cursor/hooks/hooks.json). */
  targetPath?: string;
  /** Override the acrag binary invocation (defaults to this process). */
  acragBin?: string;
}

function defaultAcragBin(): string {
  const entry = process.argv[1] ?? "";
  if (entry.endsWith("cli.ts") || entry.endsWith("cli.js")) {
    return `${process.execPath} ${resolve(entry)}`;
  }
  return process.execPath;
}

export function installHooks(opts: InstallHooksOptions = {}): {
  path: string;
  json: string;
} {
  const target = opts.targetPath ?? join(homedir(), ".cursor", "hooks", "hooks.json");
  const acragBin = opts.acragBin ?? defaultAcragBin();
  const json = renderHooksJson({ acragBin });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json + "\n", "utf8");
  info(`wrote ${target}`);
  return { path: target, json };
}

export function renderSettingsSnippet(path: string): string {
  return [
    `Installed acrag hooks to: ${path}`,
    `Cursor reads hooks from ~/.cursor/hooks/hooks.json automatically.`,
    `Set ACRAG_ARCHIVE / ACRAG_OLLAMA_HOST / ACRAG_EMBED_MODEL env vars to override defaults.`,
  ].join("\n");
}
