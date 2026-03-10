# KnowledgeVaultMCP (Local-First MVP)

A local-first knowledgebase system built with Node.js + TypeScript.
It indexes Markdown files into SQLite with FTS5, keeps the index fresh via a watcher, exposes MCP tools (read-only by default), and includes a minimal web UI for manual validation.

## Features

- Recursive indexing of `knowledge/**/*.md`
- YAML frontmatter parsing (`title`, `tags`, and arbitrary metadata)
- Chunking by heading (one row per section/chunk)
- SQLite schema with `documents`, `chunks`, `chunks_fts` (FTS5)
- Full indexing command and continuous watch mode
- Incremental updates for add/change/delete/rename (rename handled as unlink + add)
- Read-only MCP tools for agents
- Optional guarded write tool (`create_note`) for controlled note creation
- Minimal local web UI for search and doc inspection
- Request log explorer with filters and NDJSON export
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
3. Extract title, tags, headings, heading-scoped chunks, and internal markdown links.
4. Upsert one row in `documents` per file.
5. Replace chunk rows in `chunks` for that document.
6. Replace link rows in `document_links` for that document.
7. FTS index (`chunks_fts`) updates via SQLite triggers.
8. During full indexing, documents missing on disk are deleted from DB.

## How Watch Mode Works

`npm run watch` does:

1. Initial full scan/reindex.
2. Starts `chokidar` watcher on `knowledge/` and filters to `.md` files.
3. On `add` and `change`: reindex that file.
4. On `unlink`: remove file from DB.

This keeps the DB fresh as you add/edit/rename/delete local files.

## Retrieval Behavior

- Search is chunk-based, not only file-based.
- Uses SQLite FTS5 ranking (`bm25`) and snippets (`snippet`).
- Supports optional filters:
  - `pathPrefix` (e.g. `runbooks/`)
  - `tags` (frontmatter tags)
- Supports optional `maxPerDocument` to control duplicate hits per file.
- `read_doc(path)` always reads canonical Markdown from disk.
- `read_section(path, anchor, contextBefore?, contextAfter?)` reads only the section needed.
- `list_related_docs(path, limit?, modes?)` helps discover cross-page context.

## MCP Tools

- `search_knowledge(query, limit?, maxPerDocument?, pathPrefix?, tags?)`
- `read_doc(path)`
- `read_section(path, anchor, contextBefore?, contextAfter?)`
- `list_docs(pathPrefix?)`
- `list_related_docs(path, limit?, modes?)`
- `list_recent_changes(limit?)`

Tool output is JSON text suitable for agent workflows.

Optional write tool (enabled by default):

- `create_note(path, title?, tags?, body?, dryRun?)`

Disable write tool if you want read-only behavior:

```bash
MCP_ENABLE_WRITE_TOOLS=0 npm run server
```

`create_note` safety guardrails:

- only writes under `knowledge/`
- enforces `.md` paths
- never overwrites existing files (`create` only)
- supports `dryRun=true` preview without writing
- writes an audit trail to `data/mcp-write-audit.jsonl`

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
    "knowledge-vault-mcp": {
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
  "cwd": "/absolute/path/to/knowledgevaultmcp"
}
```

## Cursor Rule Example (Efficient MCP Usage)

Add this as a Cursor project rule to reduce token usage and improve retrieval quality:

```text
When answering knowledgebase questions, use this flow:
1) Call search_knowledge(query, limit=8, maxPerDocument=2) first.
2) Read only relevant sections with read_section(path, anchor, contextBefore=1, contextAfter=1).
3) Expand using list_related_docs(path, limit=5) only if confidence is low or coverage is incomplete.
4) Use read_doc(path) only when full-document context is required.
5) If you discover important system knowledge worth preserving, call create_note(path, title, tags, body, dryRun=false) to add a concise durable note under knowledge/.
6) Keep notes factual, scoped, and non-duplicative; prefer clear titles and tags.
7) Cite paths and anchors used in the final answer.
8) Never invent facts not present in returned tool data.
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

## GitHub Pages

This repo includes a GitHub Pages workflow that publishes `docs/` on pushes to `main`.

After pushing, the site will be available at:

- `https://coretracker.github.io/knowledge-vault-mcp/`

If the first deployment does not appear, set:

- **Repo Settings -> Pages -> Source: GitHub Actions**

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
