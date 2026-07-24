/**
 * `acrag bootstrap` — interactive setup wizard.
 *
 * Always: probe Ollama, create/migrate the archive, print status.
 * Automatic (no prompt): pull `bge-m3` when missing; run an initial `acrag index` sweep.
 * Interactive (Y/n): install Cursor hooks; install the Cursor agent skill.
 *
 * The Ollama check, the model pull, the sweep, and the prompt UI are injected
 * so the orchestration is deterministic without a real Ollama or TTY. When run
 * from the CLI with no injections, a TTY readline UI is used; in a non-interactive
 * (piped) context the interactive steps are skipped with a hint to run
 * `acrag install-hooks` / `acrag install-skill` explicitly.
 */
import readline from "node:readline/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkOllama } from "agent-archive-core";
import { openArchive } from "../archive/open.ts";
import { installHooks } from "./install-hooks.ts";
import { installSkill } from "./install-skill.ts";
import { runIndex } from "./index.ts";
import type { ResolvedPaths } from "../paths.ts";

export interface BootstrapUi {
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  info(message: string): void;
}

export interface RunBootstrapArgs {
  paths: ResolvedPaths;
  /** Prompt UI. If omitted, a TTY readline UI is used when stdin is a TTY. */
  ui?: BootstrapUi;
  /** Override the Ollama reachability + model check (tests). */
  checkOllamaFn?: (host: string, model: string) => Promise<string | null>;
  /** Override the `ollama pull <model>` step (tests). Streams progress by default. */
  pullModel?: (model: string) => Promise<void>;
  /** Override the initial sweep (tests). Defaults to `acrag index`. */
  sweep?: () => Promise<void>;
  /** Path used for the hooks "already installed?" check + write target. */
  hooksPath?: string;
  /** Path used for the skill "already installed?" check + write target. */
  skillPath?: string;
  /** Write the hooks file to a specific path (tests). Defaults to `installHooks`. */
  installHooksFn?: (targetPath: string) => string;
  /** Write the skill file to a specific path (tests). Defaults to `installSkill`. */
  installSkillFn?: (targetPath: string) => string;
}

export interface BootstrapOutcome {
  archive: string;
  embedModel: string;
  /** null when Ollama is reachable + the model is pulled; otherwise a diagnostic. */
  ollama: string | null;
  /** true if the model was pulled this run. */
  pulled: boolean;
  hooks: "installed" | "skipped" | "declined";
  skill: "installed" | "skipped" | "declined";
  swept: boolean;
  conversations: number;
}

async function defaultPullModel(model: string): Promise<void> {
  const r = Bun.spawn({
    cmd: ["ollama", "pull", model],
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await r.exited;
  if (code !== 0) throw new Error(`ollama pull ${model} failed (exit ${code})`);
}

function makeConfirm(
  rl: readline.Interface,
): (message: string, defaultValue: boolean) => Promise<boolean> {
  return async (message, defaultValue) => {
    const hint = defaultValue ? "Y/n" : "y/N";
    const answer = (await rl.question(`${message} [${hint}] `)).trim().toLowerCase();
    if (answer === "") return defaultValue;
    return answer === "y" || answer === "yes";
  };
}

export async function runBootstrap(
  args: RunBootstrapArgs,
): Promise<BootstrapOutcome> {
  const { paths } = args;
  const check =
    args.checkOllamaFn ??
    ((host: string, model: string) => checkOllama({ host, model }));
  const pull = args.pullModel ?? defaultPullModel;
  const sweep =
    args.sweep ??
    (async () => {
      await runIndex({ paths });
    });

  const hooksPath =
    args.hooksPath ?? join(homedir(), ".cursor", "hooks", "hooks.json");
  const skillPath =
    args.skillPath ??
    join(homedir(), ".cursor", "skills", "acrag", "SKILL.md");
  const installHooksFn =
    args.installHooksFn ?? ((p) => installHooks({ targetPath: p }).path);
  const installSkillFn =
    args.installSkillFn ?? ((p) => installSkill({ targetPath: p }).path);

  let confirm: ((m: string, d: boolean) => Promise<boolean>) | null = null;
  let rl: readline.Interface | null = null;
  if (args.ui) {
    confirm = args.ui.confirm;
  } else if (process.stdin.isTTY) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    confirm = makeConfirm(rl);
  }
  const info = args.ui?.info ?? ((m: string) => process.stdout.write(`${m}\n`));

  try {
    return await runSteps({
      paths,
      check,
      pull,
      sweep,
      confirm,
      info,
      hooksPath,
      skillPath,
      installHooksFn,
      installSkillFn,
    });
  } finally {
    rl?.close();
  }
}

interface RunStepsDeps {
  paths: ResolvedPaths;
  check: (host: string, model: string) => Promise<string | null>;
  pull: (model: string) => Promise<void>;
  sweep: () => Promise<void>;
  confirm: ((m: string, d: boolean) => Promise<boolean>) | null;
  info: (m: string) => void;
  hooksPath: string;
  skillPath: string;
  installHooksFn: (targetPath: string) => string;
  installSkillFn: (targetPath: string) => string;
}

async function runSteps(d: RunStepsDeps): Promise<BootstrapOutcome> {
  const {
    paths,
    check,
    pull,
    sweep,
    confirm,
    info,
    hooksPath,
    skillPath,
    installHooksFn,
    installSkillFn,
  } = d;

  info("acrag setup");
  info("");

  // 1. Ollama + model (pull is automatic when missing).
  info("1. Ollama");
  const diagnostic = await check(paths.ollamaHost, paths.embedModel);
  let pulled = false;
  let ollama: string | null = diagnostic;
  if (diagnostic == null) {
    info(`   reachable, model ${paths.embedModel} ready.`);
  } else if (diagnostic.includes("not pulled")) {
    info(`   reachable, but ${paths.embedModel} is not pulled.`);
    info(`   pulling ${paths.embedModel} (~2 GB)…`);
    await pull(paths.embedModel);
    pulled = true;
    ollama = null;
  } else {
    info(`   NOT reachable — ${diagnostic}`);
    info("   skipping model pull (start Ollama, then re-run bootstrap).");
  }
  info("");

  // 2. Archive (create + migrate).
  info("2. Archive");
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
  info(`   ${paths.archive} (migrations applied, ${conversations} conversations).`);
  info("");

  // 3. Cursor hooks (interactive).
  info("3. Cursor hooks");
  let hooks: BootstrapOutcome["hooks"];
  if (existsSync(hooksPath)) {
    info(`   already installed at ${hooksPath}.`);
    hooks = "skipped";
  } else if (confirm == null) {
    info("   skipped (non-interactive). Run: acrag install-hooks");
    hooks = "skipped";
  } else if (
    await confirm("Install Cursor hooks to ~/.cursor/hooks/hooks.json?", true)
  ) {
    installHooksFn(hooksPath);
    info(`   wrote ${hooksPath}.`);
    hooks = "installed";
  } else {
    info("   skipped.");
    hooks = "declined";
  }
  info("");

  // 4. Cursor agent skill (interactive).
  info("4. Cursor agent skill");
  let skill: BootstrapOutcome["skill"];
  if (existsSync(skillPath)) {
    info(`   already installed at ${skillPath}.`);
    skill = "skipped";
  } else if (confirm == null) {
    info("   skipped (non-interactive). Run: acrag install-skill");
    skill = "skipped";
  } else if (
    await confirm(
      "Install the retrieval skill to ~/.cursor/skills/acrag/SKILL.md?",
      true,
    )
  ) {
    installSkillFn(skillPath);
    info(`   wrote ${skillPath}.`);
    skill = "installed";
  } else {
    info("   skipped.");
    skill = "declined";
  }
  info("");

  // 5. Initial sweep (automatic).
  info("5. Initial sweep");
  let swept = false;
  try {
    await sweep();
    swept = true;
    info("   done.");
  } catch (e) {
    info(`   failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  info("");

  info("Setup complete.");
  const outcome: BootstrapOutcome = {
    archive: paths.archive,
    embedModel: paths.embedModel,
    ollama,
    pulled,
    hooks,
    skill,
    swept,
    conversations,
  };
  info(renderBootstrapStatus(outcome));
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
    `model pulled: ${out.pulled ? "yes (this run)" : "no"}`,
    `hooks: ${out.hooks}`,
    `skill: ${out.skill}`,
    `sweep: ${out.swept ? "done" : "skipped"}`,
    `conversations: ${out.conversations}`,
  ].join("\n");
}
