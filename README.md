# Markdown Knowledge MCP (Local-First MVP)

A local-first knowledgebase system built with Node.js + TypeScript.
It indexes Markdown files into SQLite with FTS5, keeps the index fresh via a watcher, exposes read-only MCP tools, and includes a minimal web UI for manual validation.

## Features

- Recursive indexing of `knowledge/**/*.md`
- YAML frontmatter parsing (`title`, `tags`, and arbitrary metadata)
- Chunking by heading (one row per section/chunk)
- SQLite schema with `documents`, `chunks`, `chunks_fts` (FTS5)
- Full indexing command and continuous watch mode
- Incremental updates for add/change/delete/rename (rename handled as unlink + add)
- Read-only MCP tools for agents
- Minimal local web UI for search and doc inspection
- Canonical document reads always come from disk

## Stack

- Node.js 20+
- TypeScript
- SQLite (`better-sqlite3`)
- FTS5 (built into SQLite)
- `gray-matter` for frontmatter
- `marked` for Markdown tokenization
- `chokidar` for file watching
- `@modelcontextprotocol/sdk` for MCP server
- `express` for web UI

## Project Structure

```text
.
├── data/
│   └── .gitkeep
├── knowledge/
│   ├── architecture/
│   │   └── system-overview.md
│   ├── decisions/
│   │   └── adr-0001-sqlite-fts5.md
│   ├── glossary/
│   │   └── terms.md
│   └── runbooks/
│       └── auth-service-incident.md
├── src/
│   ├── config.ts
│   ├── db.ts
│   ├── indexer-cli.ts
│   ├── indexer.ts
│   ├── mcp-core.ts
│   ├── mcp-http-server.ts
│   ├── mcp-server.ts
│   ├── parser.ts
│   ├── path-utils.ts
│   ├── search.ts
│   ├── types.ts
│   ├── watch-cli.ts
│   ├── watcher.ts
│   └── web-server.ts
├── .gitignore
├── package.json
├── README.md
└── tsconfig.json
```

## Setup

```bash
npm install
```

## Commands

```bash
npm run index    # full one-shot index
npm run watch    # initial full scan + watch for local changes
npm run server   # MCP server over HTTP at http://127.0.0.1:3000/mcp
npm run server:stdio # MCP server over stdio
npm run web      # local web UI at http://localhost:3030
npm run dev      # watcher + MCP server + web UI together
```

## How Indexing Works

1. Recursively scan `knowledge/` for `.md` files.
2. Parse frontmatter and body.
3. Extract title, tags, headings, and heading-scoped chunks.
4. Upsert one row in `documents` per file.
5. Replace chunk rows in `chunks` for that document.
6. FTS index (`chunks_fts`) updates via SQLite triggers.
7. During full indexing, documents missing on disk are deleted from DB.

## How Watch Mode Works

`npm run watch` does:

1. Initial full scan/reindex.
2. Starts `chokidar` watcher on `knowledge/**/*.md`.
3. On `add` and `change`: reindex that file.
4. On `unlink`: remove file from DB.

This keeps the DB fresh as you add/edit/rename/delete local files.

## Retrieval Behavior

- Search is chunk-based, not only file-based.
- Uses SQLite FTS5 ranking (`bm25`) and snippets (`snippet`).
- Supports optional filters:
  - `pathPrefix` (e.g. `runbooks/`)
  - `tags` (frontmatter tags)
- Limits repetitive results with max-per-document cap.
- `read_doc(path)` always reads canonical Markdown from disk.

## MCP Tools (Read-Only)

- `search_knowledge(query, limit?, pathPrefix?, tags?)`
- `read_doc(path)`
- `list_docs(pathPrefix?)`
- `list_recent_changes(limit?)`

Tool output is JSON text suitable for agent workflows.

## Connect to an MCP Client

Start the HTTP MCP server:

```bash
npm run server
```

Optional auth:

```bash
MCP_API_KEY=your-secret npm run server
```

Example IDE config (URL transport):

```json
{
  "mcpServers": {
    "knowledge-local": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "API_KEY": "your-secret"
      }
    }
  }
}
```

If your client expects stdio command transport instead, use:

```json
{
  "command": "npm",
  "args": ["run", "server:stdio"],
  "cwd": "/absolute/path/to/markdown-knowledge-mcp"
}
```

## Web UI (Manual Testing)

Start web UI:

```bash
npm run web
```

Open `http://localhost:3030`.

You can:

- search by query text
- optionally filter by path prefix
- optionally filter by tags
- open document viewer
- inspect matching sections shown for a query
- view recent changes list

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
- No write/edit/delete MCP tools
- No auth, cloud infra, or Docker requirement
- No advanced relevance tuning beyond FTS lexical ranking
