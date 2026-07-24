import { defineCommand, runMain } from "citty";
import { VERSION } from "./config.ts";
import { getEnv } from "./env.ts";
import { error } from "./log.ts";
import { resolvePaths, type ResolvedPaths } from "./paths.ts";
import type { Env } from "./schemas.ts";
import { runEmbed } from "./commands/embed.ts";
import { getPath, PathTargetSchema } from "./commands/path.ts";
import { runSql } from "./commands/sql.ts";
import { runHook } from "./commands/hook.ts";
import { runIngest } from "./commands/ingest.ts";
import { runIndex } from "./commands/index.ts";
import { installHooks, renderSettingsSnippet } from "./commands/install-hooks.ts";
import { readAllStdin, stdinIsPiped } from "agent-archive-core";

// Zero flags — everything is an env var via `getEnv()`. Defer getEnv /
// resolvePaths until a handler runs so `--help` / `--version` still work
// with a malformed env.
interface Context {
  env: Env;
  paths: ResolvedPaths;
}

let _ctx: Context | null = null;
function ctx(): Context {
  if (_ctx) return _ctx;
  const env = getEnv();
  const paths = resolvePaths({
    archive: env.ACRAG_ARCHIVE,
    ollamaHost: env.ACRAG_OLLAMA_HOST,
    embedModel: env.ACRAG_EMBED_MODEL,
    transcriptsDir: env.ACRAG_TRANSCRIPTS_DIR,
  });
  _ctx = { env, paths };
  return _ctx;
}

const DASHDASH_INDEX = process.argv.indexOf("--");
const PASSTHROUGH_ARGS: readonly string[] =
  DASHDASH_INDEX < 0 ? [] : process.argv.slice(DASHDASH_INDEX + 1);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const sqlCmd = defineCommand({
  meta: {
    name: "sql",
    description:
      "Run SQL through sqlite3 (vec preloaded, archive read-only). Pipe SQL via stdin. Forward sqlite3 flags with `--`.",
  },
  args: {
    query: {
      type: "positional",
      required: false,
      description: "Not used — pipe SQL via stdin only.",
    },
  },
  async run({ args }) {
    if (asString(args.query) != null && DASHDASH_INDEX < 0) {
      error(
        "acrag sql reads SQL from stdin only — a positional isn't accepted. " +
          "Pipe it (`echo \"…\" | acrag sql`) or use a heredoc.",
      );
      process.exit(2);
    }
    if (!stdinIsPiped() && PASSTHROUGH_ARGS.length === 0) {
      error(
        "no SQL provided: pipe it (`echo \"…\" | acrag sql`) or use a heredoc " +
          "(`acrag sql <<'SQL' … SQL`).",
      );
      process.exit(1);
    }
    const sql = stdinIsPiped() ? await readAllStdin() : null;
    const { paths } = ctx();
    const r = await runSql({
      sql,
      archive: paths.archive,
      extraArgs: [...PASSTHROUGH_ARGS],
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exitCode);
  },
});

const pathCmd = defineCommand({
  meta: {
    name: "path",
    description: "Print a path: archive (default), sqlite3, or vec0",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      description: "archive | sqlite3 | vec0",
    },
  },
  run({ args }) {
    const target = PathTargetSchema.parse(asString(args.target) ?? "archive");
    process.stdout.write(`${getPath({ target, archive: ctx().paths.archive })}\n`);
  },
});

const embedCmd = defineCommand({
  meta: {
    name: "embed",
    description:
      "Emit a SQL blob literal (x'…') of the given text's embedding. Pipe text via stdin.",
  },
  args: {
    text: {
      type: "positional",
      required: false,
      description: "Not used — pipe text via stdin only.",
    },
  },
  async run({ args }) {
    if (asString(args.text) != null) {
      error(
        "acrag embed reads text from stdin only — a positional isn't accepted. " +
          "Pipe it (`echo 'text' | acrag embed`) or use a quoted heredoc.",
      );
      process.exit(2);
    }
    if (!stdinIsPiped()) {
      error(
        "no text to embed: pipe it (`echo 'text' | acrag embed`) or use a " +
          "quoted heredoc (`acrag embed <<'EOF' … EOF`).",
      );
      process.exit(1);
    }
    const text = (await readAllStdin()).trim();
    if (text.length === 0) {
      error("no text to embed: the input was empty.");
      process.exit(2);
    }
    const { paths } = ctx();
    process.stdout.write(
      await runEmbed({
        text,
        embedModel: paths.embedModel,
        ollamaHost: paths.ollamaHost,
      }),
    );
  },
});

const hookCmd = defineCommand({
  meta: {
    name: "hook",
    description:
      "Cursor hook dispatcher (stop/subagentStop/subagentStart/workspaceOpen). Reads JSON from stdin, spawns a detached ingest/sweep, exits 0.",
  },
  args: {
    event: {
      type: "positional",
      required: true,
      description: "Cursor hook event (Stop/SubagentStop/SubagentStart/WorkspaceOpen).",
    },
  },
  async run({ args }) {
    const event = asString(args.event) ?? "";
    await runHook(event, ctx().paths.archive);
    process.exit(0);
  },
});

const ingestCmd = defineCommand({
  meta: {
    name: "ingest",
    description:
      "Background ingest entry point: read a transcript file and run the idempotent ingest pipeline.",
  },
  args: {
    path: {
      type: "positional",
      required: true,
      description: "Path to the transcript file to ingest.",
    },
  },
  async run({ args }) {
    const path = asString(args.path);
    if (!path) {
      error("acrag ingest requires a file path.");
      process.exit(2);
    }
    await runIngest(path);
    process.exit(0);
  },
});

const installHooksCmd = defineCommand({
  meta: {
    name: "install-hooks",
    description:
      "Write hooks.json to the Cursor hooks directory and print a settings snippet.",
  },
  args: {},
  run() {
    const { path } = installHooks();
    process.stdout.write(`${renderSettingsSnippet(path)}\n`);
  },
});

const indexCmd = defineCommand({
  meta: {
    name: "index",
    description:
      "Sweep the transcript dir for *.jsonl: hash-skip unchanged, ingest new, supersede changed.",
  },
  args: {
    limit: {
      type: "string",
      alias: "n",
      required: false,
      description: "Cap the number of files processed (incremental backfill).",
    },
  },
  async run({ args }) {
    const limit = asString(args.limit);
    await runIndex({
      paths: ctx().paths,
      limit: limit != null ? Number(limit) : undefined,
    });
    process.exit(0);
  },
});

const main = defineCommand({
  meta: {
    name: "acrag",
    version: VERSION,
    description:
      "Thin sqlite3 wrapper for an agent-chat archive. Adds an embed() shortcut.",
  },
  subCommands: {
    sql: sqlCmd,
    path: pathCmd,
    embed: embedCmd,
    hook: hookCmd,
    ingest: ingestCmd,
    "install-hooks": installHooksCmd,
    index: indexCmd,
  },
});

runMain(main).catch((e: unknown) => {
  error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
