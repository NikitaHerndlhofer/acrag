#!/usr/bin/env bun
/**
 * Build both Mach-O binaries (arm64 + x64) into `dist/`.
 *
 * Mirrors swrag's `scripts/build.ts`. The sqlite-vec dylibs (arm64 + x64) are
 * copied from the `agent-archive-core` dep's vendored directory into a local
 * `vendor/` staging dir so both architectures are present at build time —
 * the core bundles them via `with { type: "file" }` through the import graph
 * (`src/archive/open.ts` -> core `openArchive` -> core `vec-loader.ts`), so
 * `bun build --compile` embeds them into the executable and the runtime
 * materialises them onto the real filesystem before `dlopen()`.
 *
 * Asset filenames are pinned with `--asset-naming="[name].[ext]"` so the
 * runtime can resolve them inside the compiled `/$bunfs/` virtual FS.
 *
 * Outputs:
 *   dist/acrag-darwin-arm64
 *   dist/acrag-darwin-x64
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const VENDOR = join(ROOT, "vendor");
const CORE_VENDOR = join(ROOT, "node_modules", "agent-archive-core", "vendor");
const ENTRY = "src/cli.ts";

interface Target {
  name: string;
  bunTarget: string;
}

const TARGETS: Target[] = [
  { name: "acrag-darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { name: "acrag-darwin-x64", bunTarget: "bun-darwin-x64" },
];

const DYLIBS = ["vec0-darwin-arm64.dylib", "vec0-darwin-x64.dylib"];

function stageVendorDylibs(): void {
  console.log("[build] staging vendor dylibs from agent-archive-core");
  mkdirSync(VENDOR, { recursive: true });
  for (const d of DYLIBS) {
    const src = join(CORE_VENDOR, d);
    const dst = join(VENDOR, d);
    if (!existsSync(src)) throw new Error(`missing core vendor dylib: ${src}`);
    const srcSize = statSync(src).size;
    if (!existsSync(dst) || statSync(dst).size !== srcSize) {
      copyFileSync(src, dst);
      console.log(`[build] copied ${d} (${srcSize} bytes)`);
    } else {
      console.log(`[build] ${d} already staged (${srcSize} bytes)`);
    }
  }
}

async function main() {
  stageVendorDylibs();

  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  for (const t of TARGETS) {
    const out = join(DIST, t.name);
    console.log(`[build] compiling ${t.name}`);
    const r = Bun.spawnSync({
      cmd: [
        "bun",
        "build",
        "--compile",
        `--target=${t.bunTarget}`,
        `--asset-naming=[name].[ext]`,
        "--minify",
        ENTRY,
        "--outfile",
        out,
      ],
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (r.exitCode !== 0) throw new Error(`build failed for ${t.name}`);
    const size = statSync(out).size;
    console.log(`[build] ${t.name} -> ${out} (${size} bytes)`);
  }

  console.log("[build] done");
}

await main();
