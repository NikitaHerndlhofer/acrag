import type { Database } from "bun:sqlite";
import {
  ensureExtensionCapableSqlite as coreEnsure,
  getConfig,
  openArchive as coreOpen,
  setConfig,
  withArchive as coreWith,
  type ArchiveSchema,
  type OpenOptions,
} from "agent-archive-core";
import { EMBED_DIM } from "../config.ts";
import { getEnv } from "../env.ts";
import { MIGRATIONS } from "./migrations.ts";
import { LATEST_DATA_VERSION } from "./updaters.ts";

const ACRAG_SCHEMA: ArchiveSchema = {
  migrations: MIGRATIONS,
  seedConfig: { embed_dim: String(EMBED_DIM) },
  dataVersionSeed: LATEST_DATA_VERSION,
  freshnessTable: "conversation",
};

function withDylib(o: OpenOptions): OpenOptions {
  return {
    ...o,
    sqliteDylibPath: o.sqliteDylibPath ?? getEnv().ACRAG_SQLITE_DYLIB,
  };
}

export type { OpenOptions };
export function openArchive(path: string, options: OpenOptions = {}): Database {
  return coreOpen(path, ACRAG_SCHEMA, withDylib(options));
}
export async function withArchive<T>(
  path: string,
  options: OpenOptions,
  fn: (db: Database) => T | Promise<T>,
): Promise<T> {
  return coreWith(path, ACRAG_SCHEMA, withDylib(options), fn);
}
export function ensureExtensionCapableSqlite(): { dylib: string | null } {
  return coreEnsure({ dylibPath: getEnv().ACRAG_SQLITE_DYLIB });
}
export { getConfig, setConfig };
