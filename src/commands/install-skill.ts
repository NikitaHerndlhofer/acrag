/**
 * `acrag install-skill` (Task 11 Step 3) — write `SKILL.md` into the agent's
 * skill directory and print a short install note. Mirrors `install-hooks`:
 * create the target dir as needed, write the file, log the path.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { SKILL_MD, renderSkillInstall } from "../skill.ts";
import { info } from "../log.ts";

export interface InstallSkillOptions {
  /** Target SKILL.md path (defaults to ~/.cursor/skills/acrag/SKILL.md). */
  targetPath?: string;
}

function defaultSkillPath(): string {
  return join(homedir(), ".cursor", "skills", "acrag", "SKILL.md");
}

export function installSkill(opts: InstallSkillOptions = {}): {
  path: string;
  body: string;
} {
  const target = opts.targetPath ?? defaultSkillPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, SKILL_MD + "\n", "utf8");
  info(`wrote ${target}`);
  return { path: target, body: SKILL_MD };
}

export { renderSkillInstall };
