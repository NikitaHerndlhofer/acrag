/**
 * The condensed `SKILL.md` recipe set (spec §9) — straight instructions, all
 * 16 search variants, the subagent-driven retrieval workflow, no build
 * artifacts. The Markdown lives in `src/skill.md` (syntax highlighting, easy
 * review/edit) and is inlined into the compiled binary as a string at build
 * time via the `with { type: "text" }` import (same convention as the
 * migration SQL files).
 *
 * Written to the agent's skill location by `acrag install-skill`
 * (e.g. ~/.cursor/skills/acrag/SKILL.md).
 */
import SKILL_MD from "./skill.md" with { type: "text" };

export { SKILL_MD };

/**
 * The short install note printed after `acrag install-skill` writes the skill.
 */
export function renderSkillInstall(path: string): string {
  return [
    `Installed acrag SKILL.md to: ${path}`,
    `Cursor auto-loads skills from ~/.cursor/skills/<name>/SKILL.md.`,
    `Summons it explicitly (e.g. @acrag) — the skill is not model-invoked.`,
    `Set ACRAG_ARCHIVE / ACRAG_OLLAMA_HOST / ACRAG_EMBED_MODEL env vars to override defaults.`,
  ].join("\n");
}
