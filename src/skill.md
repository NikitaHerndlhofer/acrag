# acrag — agentic-chat archive retrieval

`acrag` is a thin sqlite3 wrapper over an archive of agent chat transcripts
(Cursor first; other agents via a version-aware parser registry). It chunks
each conversation into `chunk` rows, mirrors them into `chunk_fts` (porter
stemmed), `chunk_trigram` (fuzzy infix), and `chunk_vec` (bge-m3 `float[1024]`),
and exposes them through SQL recipes.

All recipes run through two stdin-only commands (no shell quoting issues):

- `acrag sql` — pipe a SQL statement; runs it against the archive with the vec
  extension preloaded (read-only). Forward sqlite3 flags after `--`.
- `acrag embed` — pipe text; prints a vec blob literal (`x'…'`) for
  `vec_search` / `vec0` vector columns.

```sh
echo "SELECT 1 AS ok;" | acrag sql
echo "how do I center a div" | acrag embed
```

Schema (see `acrag path archive` for the DB file): `conversation`,
`conversation_tag`, `message`, `segment`, `chunk` (denormalized
`conversation_id` / `message_id`), `chunk_fts`, `chunk_trigram`, `chunk_vec`.
`chunk.id` is an INTEGER rowid; `chunk.chunk_type` tags `text` / `code` /
`thinking` / `tool_call` / `tool_result` / `diff`.

## Retrieval workflow (subagent-driven)

A single chat can be huge (hundreds of turns, MBs of tool output). Pulling raw
chunks into the main context fills the window and loses the surrounding story.
Use a **subagent-driven retrieval** pattern instead:

1. The main agent dispatches a **subagent** (Task tool) with the question — it
   does not pull raw chunks into the main chat.
2. The subagent runs the `semantic` recipe (the **primary** search mode — best
   for "find where we discussed X"), reads the top hits, expands each to its
   neighboring turns via the `context` / `thread` recipes (loading **multiple
   messages** around the hit, not an isolated chunk), reads through those, and
   **summarizes** a focused answer back to the main agent with citations
   (`conversation_id`, `seq` ranges, `repository`).
3. The main agent uses the summary; if it needs more detail it dispatches
   another subagent with a narrower query.

`keyword` / `fuzzy` / `hybrid` remain available for exact-token lookups
(function names, error strings, file paths); `semantic` is the default for
conceptual recall.

## Recipes

### `agents`
Discover which agents/sources are archived and how many conversations each has.

```sh
echo "SELECT agent_name, COUNT(*) AS n FROM conversation GROUP BY agent_name ORDER BY n DESC;" | acrag sql
```

### `recent`
Recent conversations, newest first.

```sh
echo "SELECT id, agent_name, repository, created_at FROM conversation ORDER BY created_at DESC LIMIT 20;" | acrag sql
```

### `today`
Conversations started today.

```sh
echo "SELECT id, agent_name, repository FROM conversation WHERE date(created_at) = date('now') ORDER BY created_at DESC;" | acrag sql
```

### `turns`
Recent turns across all conversations (join `message` ↔ `conversation`).

```sh
echo "SELECT m.conversation_id, m.seq, m.role, substr(m.content,1,160) AS preview FROM message m JOIN conversation c ON c.id = m.conversation_id ORDER BY m.created_at DESC LIMIT 50;" | acrag sql
```

### `keyword`
FTS5 stemmed search over `chunk_fts` (`porter unicode61`). Best for exact
tokens — function names, error strings, file paths.

```sh
echo "SELECT c.rowid, c.conversation_id, c.message_id, c.chunk_type, substr(c.text,1,200) AS preview FROM chunk_fts f JOIN chunk c ON c.rowid = f.rowid WHERE chunk_fts MATCH 'connection pool' ORDER BY rank LIMIT 20;" | acrag sql
```

### `fuzzy`
Trigram substring/infix search over `chunk_trigram` — catches typos and
partial tokens the porter stemmer misses.

```sh
echo "SELECT c.rowid, c.conversation_id, c.chunk_type, substr(c.text,1,200) AS preview FROM chunk_trigram t JOIN chunk c ON c.rowid = t.rowid WHERE chunk_trigram MATCH 'centerd' ORDER BY rank LIMIT 20;" | acrag sql
```

### `semantic`
sqlite-vec vector search over `chunk_vec` (bge-m3 `float[1024]`). The
**primary** search mode for conceptual recall ("find where we discussed X").
Pipe the query through `acrag embed` to get a vec literal, then feed it to
`vec_search` (vec0) — the archive is opened read-only by `acrag sql`.

```sh
VEC=$(echo "how do I center a div in css" | acrag embed)
echo "SELECT c.rowid, c.conversation_id, c.message_id, c.chunk_type, substr(c.text,1,200) AS preview, v.distance FROM chunk_vec v JOIN chunk c ON c.rowid = v.rowid WHERE embedding MATCH $VEC ORDER BY v.distance LIMIT 10;" | acrag sql
```

### `recency-decay`
Semantic relevance × recency — same ranking shape as `swrag`'s recipe. Blend
vec distance with a recency weight so fresher conversations win ties.

```sh
VEC=$(echo "migrate to bun" | acrag embed)
echo "SELECT c.rowid, c.conversation_id, c.chunk_type, substr(c.text,1,200) AS preview, v.distance AS d, julianday('now') - julianday(c.created_at) AS age_days FROM chunk_vec v JOIN chunk c ON c.rowid = v.rowid WHERE embedding MATCH $VEC ORDER BY (v.distance + (julianday('now') - julianday(c.created_at)) / 365.0) LIMIT 10;" | acrag sql
```

### `hybrid`
Combine `keyword` (FTS5 rank) + `semantic` (vec distance), weighted. Run both,
union by `chunk.rowid`, and blend the scores.

```sh
VEC=$(echo "postgres pool" | acrag embed)
echo "WITH k AS (SELECT rowid, rank AS krank FROM chunk_fts WHERE chunk_fts MATCH 'postgres pool' LIMIT 50), s AS (SELECT rowid, distance AS vd FROM chunk_vec WHERE embedding MATCH $VEC LIMIT 50) SELECT c.rowid, c.conversation_id, c.chunk_type, substr(c.text,1,200) AS preview, COALESCE(k.krank, 0) AS krank, COALESCE(s.vd, 0) AS vd FROM chunk c LEFT JOIN k ON k.rowid = c.rowid LEFT JOIN s ON s.rowid = c.rowid WHERE k.rowid IS NOT NULL OR s.rowid IS NOT NULL ORDER BY (COALESCE(s.vd, 2.0) - COALESCE(k.krank, 0) / 100.0) LIMIT 20;" | acrag sql
```

### `by-agent`
Filter conversations/turns by `agent_name` (e.g. only Cursor chats).

```sh
echo "SELECT id, repository, created_at FROM conversation WHERE agent_name = 'cursor' ORDER BY created_at DESC LIMIT 20;" | acrag sql
```

### `by-repo`
Filter conversations/turns by `repository` (e.g. all chats in `SuperWhisperRag`).

```sh
echo "SELECT id, agent_name, created_at FROM conversation WHERE repository = 'SuperWhisperRag' ORDER BY created_at DESC LIMIT 20;" | acrag sql
```

### `by-tag`
Filter conversations by a dynamic tag via `conversation_tag` (e.g. `background`).

```sh
echo "SELECT c.id, c.agent_name, c.repository FROM conversation c JOIN conversation_tag t ON t.conversation_id = c.id WHERE t.tag = 'background' ORDER BY c.created_at DESC;" | acrag sql
```

### `subagents`
Conversations with a `parent_conversation_id` (subagent transcripts), optionally
joined to their parent.

```sh
echo "SELECT c.id, c.parent_conversation_id, c.repository, c.created_at FROM conversation c WHERE c.parent_conversation_id IS NOT NULL ORDER BY c.created_at DESC LIMIT 50;" | acrag sql
```

### `thread`
Reconstruct a full conversation: all `message` rows for a `conversation_id`
ordered by `seq` — the "give me the whole chat" recipe.

```sh
echo "SELECT seq, role, substr(content,1,200) AS preview FROM message WHERE conversation_id = '<conv-id>' ORDER BY seq;" | acrag sql
```

### `context`
Neighboring turns around a given chunk — join `chunk` → `message` by
`conversation_id` and pull adjacent `seq` values. Use after a `semantic` /
`keyword` hit to read "what was said around this".

```sh
echo "SELECT m.seq, m.role, substr(m.content,1,240) AS preview FROM message m WHERE m.conversation_id = (SELECT conversation_id FROM chunk WHERE rowid = <chunk-rowid>) AND m.seq BETWEEN (<hit-seq> - 2) AND (<hit-seq> + 2) ORDER BY m.seq;" | acrag sql
```

### `by-chunk-type`
Filter chunks by `chunk_type` (only `text` prompts, only `code` the agent wrote,
only `diff`s) — optionally combined with `keyword` / `semantic`.

```sh
echo "SELECT rowid, conversation_id, substr(text,1,200) AS preview FROM chunk WHERE chunk_type = 'diff' ORDER BY created_at DESC LIMIT 30;" | acrag sql
```

## Notes

- `acrag sql` opens the archive read-only; recipes never mutate.
- `acrag embed` returns a vec literal suitable for `vec_search` / `vec0` —
  pipe it, don't paste raw floats.
- Combine recipes: `by-chunk-type` + `keyword`, `by-repo` + `semantic`, etc.
  Recipes are SQL fragments, not a fixed API.
