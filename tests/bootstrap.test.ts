/**
 * `acrag bootstrap` — interactive setup wizard.
 *
 * Behaviour (per user):
 *   - probe Ollama, create/migrate the archive, print status  (always)
 *   - pull bge-m3 automatically when missing                 (automatic)
 *   - initial `acrag index` sweep                            (automatic)
 *   - install Cursor hooks                                   (interactive Y/n)
 *   - install Cursor agent skill                             (interactive Y/n)
 *
 * The Ollama check, the model pull, the sweep, and the prompt UI are injected
 * so the orchestration is deterministic without a real Ollama / TTY. Hooks
 * and skill land at injected temp paths so the real ~/.cursor is never touched.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap, type BootstrapUi } from "../src/commands/bootstrap.ts";

function makeUi(answers: Record<string, boolean>): BootstrapUi & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    info: (m: string) => {
      log.push(m);
    },
    confirm: async (message: string, defaultValue: boolean) => {
      log.push(`? ${message} [${defaultValue ? "Y/n" : "y/N"}]`);
      return message in answers ? answers[message] : defaultValue;
    },
  };
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "acrag-boot-"));
}

function pathsFor(home: string) {
  return {
    paths: {
      archive: join(home, "acrag.sqlite"),
      ollamaHost: "http://127.0.0.1:11434",
      embedModel: "bge-m3",
      transcriptsDir: join(home, "transcripts"),
    },
    hooksPath: join(home, ".cursor", "hooks", "hooks.json"),
    skillPath: join(home, ".cursor", "skills", "acrag", "SKILL.md"),
  };
}

describe("acrag bootstrap", () => {
  test("pulls missing model automatically, installs hooks+skill when confirmed, sweeps", async () => {
    const home = tempHome();
    const pulled: string[] = [];
    const swept: string[] = [];
    const ui = makeUi({
      "Install Cursor hooks to ~/.cursor/hooks/hooks.json?": true,
      "Install the retrieval skill to ~/.cursor/skills/acrag/SKILL.md?": true,
    });

    const out = await runBootstrap({
      ...pathsFor(home),
      ui,
      checkOllamaFn: async () =>
        'embed model "bge-m3" not pulled. Run: ollama pull bge-m3',
      pullModel: async (m) => {
        pulled.push(m);
      },
      sweep: async () => {
        swept.push("yes");
      },
    });

    expect(pulled).toEqual(["bge-m3"]);
    expect(swept).toEqual(["yes"]);
    expect(existsSync(join(home, ".cursor", "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(join(home, ".cursor", "skills", "acrag", "SKILL.md"))).toBe(
      true,
    );
    expect(out.pulled).toBe(true);
    expect(out.hooks).toBe("installed");
    expect(out.skill).toBe("installed");
    expect(out.swept).toBe(true);
    expect(out.conversations).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  test("skips pull when model already pulled, skips hooks/skill when declined", async () => {
    const home = tempHome();
    const pulled: string[] = [];
    const swept: string[] = [];
    const ui = makeUi({
      "Install Cursor hooks to ~/.cursor/hooks/hooks.json?": false,
      "Install the retrieval skill to ~/.cursor/skills/acrag/SKILL.md?": false,
    });

    const out = await runBootstrap({
      ...pathsFor(home),
      ui,
      checkOllamaFn: async () => null, // reachable + model already pulled
      pullModel: async (m) => {
        pulled.push(m);
      },
      sweep: async () => {
        swept.push("yes");
      },
    });

    expect(pulled).toEqual([]); // already pulled -> no pull
    expect(swept).toEqual(["yes"]); // sweep is automatic regardless
    expect(existsSync(join(home, ".cursor", "hooks", "hooks.json"))).toBe(false);
    expect(existsSync(join(home, ".cursor", "skills", "acrag", "SKILL.md"))).toBe(
      false,
    );
    expect(out.pulled).toBe(false);
    expect(out.hooks).toBe("declined");
    expect(out.skill).toBe("declined");
    rmSync(home, { recursive: true, force: true });
  });

  test("skips pull when Ollama unreachable, still migrates + sweeps", async () => {
    const home = tempHome();
    const pulled: string[] = [];
    const swept: string[] = [];
    const ui = makeUi({});

    const out = await runBootstrap({
      ...pathsFor(home),
      ui,
      checkOllamaFn: async () =>
        "cannot reach Ollama at http://127.0.0.1:11434: ...",
      pullModel: async (m) => {
        pulled.push(m);
      },
      sweep: async () => {
        swept.push("yes");
      },
    });

    expect(pulled).toEqual([]); // ollama down -> cannot pull
    expect(swept).toEqual(["yes"]);
    expect(out.pulled).toBe(false);
    expect(out.ollama).toContain("cannot reach");
    expect(out.conversations).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  test("skips hooks/skill prompts when already installed", async () => {
    const home = tempHome();
    const { installHooks } = await import("../src/commands/install-hooks.ts");
    const { installSkill } = await import("../src/commands/install-skill.ts");
    const p = pathsFor(home);
    // Pre-install hooks + skill so bootstrap sees them as already present.
    installHooks({ targetPath: p.hooksPath });
    installSkill({ targetPath: p.skillPath });

    const base = makeUi({});
    let asked = 0;
    const ui: BootstrapUi = {
      info: (m) => base.info(m),
      confirm: async (m, d) => {
        asked += 1;
        return base.confirm(m, d);
      },
    };

    const out = await runBootstrap({
      ...p,
      ui,
      checkOllamaFn: async () => null,
      pullModel: async () => {},
      sweep: async () => {},
    });

    expect(asked).toBe(0); // neither hooks nor skill prompted
    expect(out.hooks).toBe("skipped");
    expect(out.skill).toBe("skipped");
    rmSync(home, { recursive: true, force: true });
  });
});
