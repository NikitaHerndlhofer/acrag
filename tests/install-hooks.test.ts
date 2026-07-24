// tests/install-hooks.test.ts
import { test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooks } from "../src/commands/install-hooks.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "acrag-hooks-"));
}

test("installHooks writes Cursor v1 schema with camelCase events + bare acrag command", () => {
  const dir = tempDir();
  try {
    const target = join(dir, "hooks.json");
    const { json } = installHooks({ targetPath: target });
    const obj = JSON.parse(json);
    expect(obj.version).toBe(1);
    expect(obj.hooks.stop[0].command).toBe("acrag hook stop");
    expect(obj.hooks.subagentStop[0].command).toBe("acrag hook subagentStop");
    expect(obj.hooks.subagentStart[0].command).toBe("acrag hook subagentStart");
    expect(obj.hooks.workspaceOpen[0].command).toBe("acrag hook workspaceOpen");
    // file actually written
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(obj);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installHooks merges into an existing hooks.json, preserving unrelated hooks", () => {
  const dir = tempDir();
  try {
    const target = join(dir, "hooks.json");
    // Pre-existing user hook that must survive.
    const preexisting = {
      version: 1,
      hooks: {
        afterFileEdit: [{ command: "./hooks/format.sh" }],
        stop: [{ command: "./hooks/old-stop.sh" }],
      },
    };
    writeFileSync(target, JSON.stringify(preexisting));
    installHooks({ targetPath: target });
    const obj = JSON.parse(readFileSync(target, "utf8"));
    // acrag's events replaced
    expect(obj.hooks.stop[0].command).toBe("acrag hook stop");
    expect(obj.hooks.subagentStop[0].command).toBe("acrag hook subagentStop");
    // unrelated hook preserved
    expect(obj.hooks.afterFileEdit[0].command).toBe("./hooks/format.sh");
    expect(obj.version).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
