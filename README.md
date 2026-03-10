# KnowledgeVaultMCP

> Local-first Markdown memory for people who label cables and grind their own coffee.

KnowledgeVaultMCP indexes `knowledge/**/*.md` into SQLite (FTS5), keeps it fresh with file watching, serves MCP tools for agents, and ships a tiny web UI for sanity checks.

## Why This Exists

- You want fast, local retrieval without cloud dependency.
- You want structured notes (frontmatter + headings), not one giant blob.
- You want agent-friendly tools that can search/read safely.
- You still want a human-readable web UI when debugging weird cases.

## Features

- Recursive indexing for Markdown files under `knowledge/`
- YAML frontmatter parsing (`title`, `tags`, plus arbitrary metadata)
- Section-level chunking by heading for sharper retrieval
- SQLite tables: `documents`, `chunks`, `document_links`, `chunks_fts`
- FTS5 search with `bm25` ranking and snippet extraction
- Watch mode for add/change/delete updates
- MCP read tools for search and targeted reads
- Optional guarded write tool: `create_note(...)`
- Local web UI for query checks + document inspection
- Canonical reads always come from disk, not DB snapshots

## Stack

- Node.js 20+
- TypeScript
- SQLite via `better-sqlite3`
- `gray-matter` (frontmatter parsing)
- `marked` (Markdown tokenization)
- `chokidar` (file watching)
- `@modelcontextprotocol/sdk` (MCP server)
- `express` (web UI)

## Quick Start

```bash
npm install
npm run dev
```

`npm run dev` starts:

- watcher/indexer
- MCP HTTP server (`http://127.0.0.1:3000/mcp`)
- web UI (`http://localhost:3030`)

## Commands

```bash
npm run index         # one-shot full reindex
npm run watch         # full scan, then watch for local changes
npm run server        # MCP server over HTTP (127.0.0.1:3000/mcp)
npm run server:http   # same as server
npm run server:stdio  # MCP server over stdio transport
npm run web           # local web UI (localhost:3030)
npm run dev           # watch + MCP HTTP + web together
```

## How It Works

### Indexing pipeline

1. Scan `knowledge/` recursively for `.md`.
2. Parse frontmatter + markdown body.
3. Extract headings, section chunks, tags, links.
4. Upsert document row.
5. Replace chunk rows for that document.
6. Replace internal link rows for that document.
7. Let SQLite triggers refresh `chunks_fts`.
8. Remove DB rows for files missing on disk during full index.

### Watch mode

`npm run watch` performs an initial full index, then listens via `chokidar`:

- `add` / `change` => reindex file
- `unlink` => delete file rows from DB

## Retrieval Behavior

- Retrieval is chunk-first (section-level), not file-only.
- Optional filters:
- `pathPrefix` (example: `runbooks/`)
- `tags` (from frontmatter)
- `maxPerDocument` can reduce repeated hits from the same file.
- `read_doc(path)` returns canonical markdown from disk.
- `read_section(path, anchor, contextBefore?, contextAfter?)` returns only the needed section.
- `list_related_docs(path, limit?, modes?)` helps expand context.

## MCP Tools

### Read tools

- `search_knowledge(query, limit?, maxPerDocument?, pathPrefix?, tags?)`
- `read_doc(path)`
- `read_section(path, anchor, contextBefore?, contextAfter?)`
- `list_docs(pathPrefix?)`
- `list_related_docs(path, limit?, modes?)`
- `list_recent_changes(limit?)`

### Optional write tool

- `create_note(path, title?, tags?, body?, dryRun?)`

Disable write tools for strict read-only mode:

```bash
MCP_ENABLE_WRITE_TOOLS=0 npm run server
```

Write guardrails:

- writes only under `knowledge/`
- accepts only `.md` paths
- never overwrites existing files
- supports `dryRun=true`
- appends audit log to `data/mcp-write-audit.jsonl`

## MCP Client Setup

Start server:

```bash
npm run server
```

Optional API key:

```bash
MCP_API_KEY=your-secret npm run server
```

URL transport config example:

```json
{
  "mcpServers": {
    "knowledge-vault-mcp": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "API_KEY": "your-secret"
      }
    }
  }
}
```

Stdio transport config example:

```json
{
  "command": "npm",
  "args": ["run", "server:stdio"],
  "cwd": "/absolute/path/to/knowledgevaultmcp"
}
```

## Cursor Rule (Efficient Usage)

```text
When answering knowledgebase questions, use this flow:
1) Call search_knowledge(query, limit=8, maxPerDocument=2) first.
2) Read only relevant sections with read_section(path, anchor, contextBefore=1, contextAfter=1).
3) Expand using list_related_docs(path, limit=5) only if confidence is low or coverage is incomplete.
4) Use read_doc(path) only when full-document context is required.
5) If you discover important system knowledge worth preserving, call create_note(path, title, tags, body, dryRun=false) under knowledge/.
6) Keep notes factual, scoped, and non-duplicative.
7) Cite paths and anchors used in the final answer.
8) Never invent facts not present in returned tool data.
```

## Manual Web Check

```bash
npm run web
```

Open `http://localhost:3030` and test:

- query search
- `pathPrefix` filter
- `tags` filter
- document viewer
- section matches
- recent changes

## Local Test Flow

1. `npm run index`
2. `npm run web` and search for terms like `incident` or `fts5`
3. `npm run watch`
4. Edit or add a Markdown file in `knowledge/`
5. Re-run search in UI and confirm results update
6. Start MCP server with `npm run server` and call tools from your MCP client

## Intentional MVP Scope Limits

- No embeddings
- No vector database
- No external search services
- No edit/delete MCP tools
- No auth, cloud infra, or Docker requirement
- No advanced relevance tuning beyond FTS lexical ranking
