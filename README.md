# acrag

A local-first, append-only archive of your **agentic coding chat history**
(Cursor first; other agents via a version-aware parser registry) with
full-text, fuzzy, and multilingual semantic search.

`acrag` keeps a private SQLite database in sync with your agent
conversations, chunks each one into `chunk` rows, mirrors them into
`chunk_fts` (porter stemmed), `chunk_trigram` (fuzzy infix), and
`chunk_vec` (`bge-m3` `float[1024]`, 100+ languages via local
[Ollama](https://ollama.com)), and exposes the whole thing as a thin
[`sqlite3`](https://sqlite.org) wrapper.

Agentic coding tools are great at _doing_ but bad at _remembering_. A
single chat can run for hundreds of turns across days, and once it
scrolls off the top of the UI it's effectively gone — you can't ask
"where did we figure out that connection-pool bug?" across weeks of
sessions. `acrag` extracts the searchable substance (prompts, replies,
code, diffs, tool calls, tool results) into its own small archive and
leaves the source of truth to the agent.

It's useful if you:

- Want to search past agent chats — semantically (any language) or by
  keyword — without scrolling Cursor's history.
- Want an AI agent (Cursor, Claude Code) to look things up in your past
  coding conversations on demand.
- Want a local, private, queryable history of your agent coding sessions.
  No cloud, no telemetry, no account.

## Quick taste

```bash
# Recent conversations, newest first.
acrag sql <<'SQL'
SELECT id, agent_name, repository, created_at
FROM conversation
WHERE superseded_by IS NULL
ORDER BY created_at DESC
LIMIT 20;
SQL

# Which repos have you been chatting about, and how much per repo.
acrag sql <<'SQL'
SELECT repository, COUNT(*) AS n
FROM conversation
WHERE superseded_by IS NULL
GROUP BY repository
ORDER BY n DESC;
SQL

# Keyword search with snippets. chunk_fts is porter-stemmed (unicode61) —
# best for exact tokens: function names, error strings, file paths.
acrag sql <<'SQL'
SELECT c.rowid, c.conversation_id, c.chunk_type,
       substr(c.text,1,200) AS preview
FROM chunk_fts f
JOIN chunk c ON c.rowid = f.rowid
WHERE chunk_fts MATCH 'connection pool'
ORDER BY rank
LIMIT 20;
SQL

# Fuzzy / substring search via the trigram index. chunk_trigram matches
# 3-character windows, so it catches infixes ('icing' inside 'pricing'),
# glued identifiers, and typos ('notifcations'). Needs >=3 chars; no
# stemming (use chunk_fts for that).
acrag sql <<'SQL'
SELECT c.rowid, c.conversation_id, c.chunk_type,
       substr(c.text,1,200) AS preview
FROM chunk_trigram t
JOIN chunk c ON c.rowid = t.rowid
WHERE chunk_trigram MATCH 'centerd'
ORDER BY rank
LIMIT 20;
SQL

# Semantic search — works in any language; the shell composes the embedding.
# `$(echo '…' | acrag embed)` runs in a subshell with its own stdin, so it
# splices cleanly into the heredoc body.
VEC=$(echo "how do I center a div in css" | acrag embed)
acrag sql <<SQL
SELECT c.rowid, c.conversation_id, c.message_id, c.chunk_type,
       substr(c.text,1,200) AS preview, v.distance
FROM chunk_vec v
JOIN chunk c ON c.rowid = v.rowid
WHERE embedding MATCH $VEC
ORDER BY v.distance
LIMIT 10;
SQL

# Reconstruct a whole conversation — all turns in order.
acrag sql <<'SQL'
SELECT seq, role, substr(content,1,200) AS preview
FROM message
WHERE conversation_id = '<conv-id>'
ORDER BY seq;
SQL
```

## Long conversations & chunking

A single agent chat can be huge — hundreds of turns, megabytes of tool
output. `acrag` chunks each conversation so retrieval returns a focused
window, not "this hour-long session probably talked about it".

The chunker is **per-turn on the outside, segment-aware on the inside**:
each message is split into typed `segment`s (`text` / `code` / `thinking`
/ `tool_call` / `tool_result` / `diff`), and large segments are split into
multiple `chunk` rows — never truncated — each with a contextual header
and a slight overlap so meaning isn't lost at a boundary. Small messages
become a single chunk; big ones fan out into several, all sharing the same
`conversation_id` / `message_id` (denormalized onto `chunk` for fast
filtering) and a `sub` index.

`chunk_type` lets you scope a search: only the `code` the agent wrote,
only the `diff`s, only `tool_result`s, etc.

## Install

macOS + [Homebrew](https://brew.sh):

```bash
brew install NikitaHerndlhofer/tap/acrag
acrag bootstrap
```

Two commands, end to end. `brew install` handles the binary and dependencies
(`sqlite` and `ollama` are pulled in for you). `acrag bootstrap` is an
**interactive setup wizard**:

1. **Ollama** — probes Ollama and, if `bge-m3` isn't pulled yet, pulls it
   automatically (~2 GB, one-time). If Ollama isn't running, it says so and
   skips the pull (start Ollama, then re-run).
2. **Archive** — runs the schema migrations to create the archive at
   `~/.acrag/acrag.sqlite` (idempotent via `PRAGMA user_version`).
3. **Cursor hooks** — asks `Install Cursor hooks to ~/.cursor/hooks/hooks.json?
   [Y/n]`. If yes, wires Cursor to fire `acrag` on `Stop` / `SubagentStop` /
   `SubagentStart` / `WorkspaceOpen` so the agent never blocks on embedding
   (see below). Skipped automatically if already installed.
4. **Cursor agent skill** — asks `Install the retrieval skill to
   ~/.cursor/skills/acrag/SKILL.md? [Y/n]`. If yes, writes the recipe `SKILL.md`
   (manual-invocation only — the agent can't reach for it autonomously). Skipped
   if already installed.
5. **Initial sweep** — runs `acrag index` automatically to ingest anything
   already in `~/.acrag/transcripts`.
6. Prints a status summary.

Each step is idempotent — re-run `acrag bootstrap` any time to restore the
setup to a known-good state (already-done steps are skipped). Each step is also
independently invokable (`acrag index`, `acrag install-hooks`,
`acrag install-skill`) if you'd rather pick and choose. In a non-interactive
(piped) context the two prompt steps are skipped with a hint to run those
commands yourself; the automatic steps still run.

### About the hooks

Ingestion is **event-driven and detached**. Cursor fires one of four hook
events and pipes a small JSON payload on stdin; `acrag hook <event>` reads
it, spawns a **background** `acrag ingest` (or `acrag index` sweep) via
`nohup … &`, and exits 0 instantly — so the agent never waits on
embedding. The four events:

- `Stop` — ingest the conversation transcript at `transcript_path`.
- `SubagentStop` — ingest the subagent transcript at
  `agent_transcript_path`, linked to its parent via `subagent_map`.
- `SubagentStart` — record the parent↔subagent link for later
  `SubagentStop` to pick up.
- `WorkspaceOpen` — sweep the transcript dir for anything new/changed.

`acrag install-hooks` writes the `hooks.json` that maps these; Cursor
reads it from `~/.cursor/hooks/hooks.json` automatically. No cron, no
polling, no daemon of our own.

### About the agent skill

`acrag install-skill` writes `SKILL.md` to `~/.cursor/skills/acrag/`. The
skill is a set of SQL **recipes** (`recent`, `keyword`, `fuzzy`,
`semantic`, `hybrid`, `thread`, `context`, `by-repo`, `by-agent`,
`by-tag`, `by-chunk-type`, `subagents`, …) plus a **subagent-driven
retrieval** workflow: a chat can be huge, so instead of pulling raw
chunks into the main context, you dispatch a subagent that runs the
`semantic` recipe, reads the top hits, expands each to its neighboring
turns, and **summarizes** a focused answer back with citations. The
skill is manual-invocation only — type `@acrag` (Cursor) to use it; the
agent can't reach for it on its own.

### Verify the setup

```bash
acrag bootstrap
# 1. Ollama
#    reachable, model bge-m3 ready.
# 2. Archive
#    ~/.acrag/acrag.sqlite (migrations applied, 0 conversations).
# 3. Cursor hooks
#    Install Cursor hooks to ~/.cursor/hooks/hooks.json? [Y/n] y
#    wrote ~/.cursor/hooks/hooks.json.
# 4. Cursor agent skill
#    Install the retrieval skill to ~/.cursor/skills/acrag/SKILL.md? [Y/n] y
#    wrote ~/.cursor/skills/acrag/SKILL.md.
# 5. Initial sweep
#    done.
# Setup complete.
# archive: ~/.acrag/acrag.sqlite
# embed model: bge-m3
# ollama: reachable (bge-m3)
# model pulled: no
# hooks: installed
# skill: installed
# sweep: done
# conversations: 0
```

Then chat in Cursor for a bit; a `Stop` event will trigger a background
ingest, and `acrag sql` will start returning rows.

## Configuration

Zero flags — everything is an env var (validated once per process):

| Env var                 | Default                         | What it overrides                             |
| ----------------------- | ------------------------------- | --------------------------------------------- |
| `ACRAG_ARCHIVE`         | `~/.acrag/acrag.sqlite`         | Archive DB path.                              |
| `ACRAG_TRANSCRIPTS_DIR` | `~/.acrag/transcripts`          | Dir `acrag index` sweeps for `*.jsonl`.       |
| `ACRAG_OLLAMA_HOST`     | `http://127.0.0.1:11434`        | Ollama endpoint for `acrag embed`.            |
| `ACRAG_EMBED_MODEL`     | `bge-m3`                        | Ollama embed model (1024-d).                  |
| `ACRAG_SQLITE_DYLIB`    | Homebrew sqlite (auto-detected) | sqlite dylib with loadable-extension support. |

Set them in your shell (or Cursor's env) to override. `acrag path
archive` prints the resolved archive path for the current env.

## Commands

| Command                               | What it does                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `acrag sql`                           | Run SQL through `sqlite3` (vec preloaded, archive read-only). Pipe SQL via stdin. Forward sqlite3 flags after `--`.               |
| `acrag embed`                         | Print a vec blob literal (`x'…'`) of the piped text's embedding — for `vec_search` / `vec0` vector columns.                       |
| `acrag path [archive\|sqlite3\|vec0]` | Print a resolved path.                                                                                                            |
| `acrag index [-n N]`                  | Sweep the transcript dir for `*.jsonl`: hash-skip unchanged, ingest new, supersede changed. `--limit N` caps files (incremental). |
| `acrag ingest <path>`                 | Background ingest entry point: read one transcript file, run the idempotent ingest pipeline.                                      |
| `acrag hook <event>`                  | Cursor hook dispatcher. Reads JSON from stdin, spawns a detached ingest/sweep, exits 0.                                           |
| `acrag install-hooks`                 | Write `~/.cursor/hooks/hooks.json` and print a settings note.                                                                     |
| `acrag install-skill`                 | Write the recipe `SKILL.md` to `~/.cursor/skills/acrag/` and print an install note.                                               |
| `acrag bootstrap`                     | Check Ollama, pull `bge-m3` if missing, create/migrate the archive, prompt to install hooks + skill, run an initial sweep, print status. Idempotent.                                                   |

## Forwarding flags to sqlite3

`acrag sql` is a thin passthrough — anything after `--` goes to sqlite3
verbatim, slotted between our setup (`.load vec0 …`) and the archive URI:

```bash
# JSON output
echo "SELECT id, agent_name FROM conversation LIMIT 3;" | acrag sql -- -json

# Markdown table for human reading
echo "SELECT id, agent_name FROM conversation LIMIT 3;" | acrag sql -- -box

# Compose with semantic embeddings (the `acrag embed` trick still works)
VEC=$(echo "migrate to bun" | acrag embed)
acrag sql -- -box <<SQL
SELECT c.conversation_id, c.chunk_type, substr(c.text,1,160) AS preview, v.distance
FROM chunk_vec v JOIN chunk c ON c.rowid = v.rowid
WHERE embedding MATCH $VEC ORDER BY v.distance LIMIT 10;
SQL
```

## Piping SQL & embeddings (quoting-safe)

Pipe SQL via stdin and you only need SQL-standard `''` doubling for
string literals — no shell-quoting gymnastics:

```bash
# Pipe SQL — only SQL-standard '' doubling needed for string literals.
acrag sql <<'SQL'
SELECT id, repository FROM conversation
WHERE repository LIKE '%SuperWhisper%' AND superseded_by IS NULL
ORDER BY created_at DESC LIMIT 10;
SQL

# Quoting-safe semantic search: embed via stdin, interpolate the blob.
VEC=$(echo "postgres connection pool exhaustion" | acrag embed)
acrag sql <<SQL
SELECT c.conversation_id, c.chunk_type, substr(c.text,1,200) AS preview, v.distance
FROM chunk_vec v JOIN chunk c ON c.rowid = v.rowid
WHERE embedding MATCH $VEC ORDER BY v.distance LIMIT 10;
SQL
```

## Schema

`acrag path archive` prints the DB file. Tables (relational, with
denormalized IDs on `chunk` for query speed, maintained by a trigger):

- `conversation` — one per chat (`id`, `agent_name`, `repository`,
  `source_path`, `file_hash`, `parent_conversation_id`, `model`,
  `superseded_by`, `created_at`).
- `conversation_tag` — dynamic tags (`background`, …).
- `message` — one per turn (`id`, `conversation_id`, `seq`, `role`,
  `content`, `tool_name`, `tool_call_id`, `created_at`, `content_hash`).
- `segment` — typed slices of a message (`id`, `message_id`, `index`,
  `kind`, `content`, `tool_name`, `tool_call_id`,
  `agent_transcript_path`).
- `chunk` — the retrievable unit (`id` INTEGER rowid, `segment_id`,
  denormalized `conversation_id` / `message_id`, `sub`, `chunk_type`,
  `text`, `content_hash`, `created_at`).
- `chunk_fts` / `chunk_trigram` / `chunk_vec` — FTS5 (porter), FTS5
  (trigram), and `vec0` (`float[1024]`) mirrors of `chunk.text`, kept in
  sync by triggers.
- `subagent_map` — parent↔subagent links for subagent transcripts.

`chunk.id` is an INTEGER rowid; `chunk.chunk_type` tags `text` / `code` /
`thinking` / `tool_call` / `tool_result` / `diff`.

Ingestion is idempotent: `conversation.file_hash` skips unchanged
sources, `chunk.content_hash` skips re-embedding unchanged chunks, and a
changed source **supersedes** the old conversation (`superseded_by`) and
removes its stale vec rows.

## Parsers & chunkers (extensible)

Different agents — and different _versions_ of the same agent — store
chats differently. `acrag` resolves a `(parser, chunker)` pair per
conversation through a **version-aware registry**:

1. A parser's `detect()` reads the source and returns `(agent, version)`.
2. The registry picks the parser whose version range contains the
   detected version (exact first, then nearest-below, then nearest-above),
   falling back to a **generic** parser/chunker if nothing matches.
3. `parseAndChunk` runs the chosen parser per conversation and the
   matching chunker over its segments.

Cursor v1 is implemented today; the generic fallback handles anything
JSON-ish. Adding a new agent or version is a new file under
`src/parsers/<agent>/<version>.ts` + `src/chunkers/<agent>/<version>.ts`
and a registry entry — no core changes.

## Privacy

Everything is local. The archive is a SQLite file on your disk; embeddings
go to your local Ollama. No cloud, no telemetry, no account. `acrag sql`
opens the archive **read-only**, so recipes never mutate.

## License

[MIT](./LICENSE). Built on [`agent-archive-core`](https://github.com/NikitaHerndlhofer/agent-archive-core),
the shared, schema-agnostic archive mechanism (SQLite + sqlite-vec + FTS5

- Ollama embeddings) that `acrag` and `swrag` both build on.
