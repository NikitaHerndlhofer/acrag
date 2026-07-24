import { test, expect } from "bun:test";
import { SKILL_MD } from "../src/skill.ts";

const RECIPES = [
  "agents",
  "recent",
  "today",
  "turns",
  "keyword",
  "fuzzy",
  "semantic",
  "recency-decay",
  "hybrid",
  "by-agent",
  "by-repo",
  "by-tag",
  "subagents",
  "thread",
  "context",
  "by-chunk-type",
];

test("SKILL.md documents every recipe as a header", () => {
  for (const slug of RECIPES) {
    expect(SKILL_MD, `missing recipe header: ${slug}`).toContain(
      `### \`${slug}\``,
    );
  }
});

test("SKILL.md recommends the subagent-driven retrieval workflow", () => {
  expect(SKILL_MD).toMatch(/subagent/i);
  expect(SKILL_MD).toContain("acrag sql");
  expect(SKILL_MD).toContain("acrag embed");
});

test("SKILL.md has no build artifacts (no bun build / compile instructions)", () => {
  expect(SKILL_MD).not.toMatch(/bun build/);
  expect(SKILL_MD).not.toMatch(/bunx tsc/);
});
