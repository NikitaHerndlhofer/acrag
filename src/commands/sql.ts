import { runSqlite3, type Sqlite3Result } from "agent-archive-core";

/**
 * Run a SQL query against the archive by exec'ing the sqlite3 CLI.
 *
 * Thin passthrough: open the archive read-only, preload vec0, hand the
 * user's SQL to sqlite3 and forward its stdout/stderr/exit.
 *
 * For semantic search, compose with `acrag embed` (text via stdin → `x'…'` blob).
 */
export interface RunSqlOptions {
  /** SQL to execute. `null`/empty with no passthrough is an error (pipe-only, no REPL). */
  sql: string | null;
  archive: string;
  /**
   * Verbatim sqlite3 args forwarded after our setup flags. Populated when
   * the user wrote `acrag sql -- <stuff>`.
   */
  extraArgs?: string[];
}

export async function runSql(opts: RunSqlOptions): Promise<Sqlite3Result> {
  const extra = opts.extraArgs ?? [];
  const trimmed = (opts.sql ?? "").trim();

  if (extra.length > 0) {
    return runSqlite3({
      archive: opts.archive,
      sql: trimmed.length > 0 ? trimmed : null,
      readonly: true,
      extraArgs: extra,
    });
  }

  if (trimmed.length === 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "no SQL provided: pipe it via stdin (`echo \"…\" | acrag sql`).",
    };
  }

  return runSqlite3({
    archive: opts.archive,
    sql: trimmed,
    readonly: true,
  });
}
